# USDZ 加动效：给现成的 USDZ 加漂浮、轨迹、入场

下拉菜单第三个模式。拿任何 USDZ（我们自己导出的、扫描的、Reality Composer 的都行），
在网页里看着调，导出时把运动烘成关键帧写进文件，放进 Keynote 就动。
所有 Keynote 相关的规律都是 2026-09-14 拿真实文件实测出来的，不是照规范猜的。

## 能做什么

- **漂浮**：三条互不成整数比的正弦叠在一起（Y 位移 1.25、X 倾 0.68、Z 倾 0.82 rad/s），
  看起来像随机呼吸而不是钟摆。档位不动 / 轻 / 中 / 重，节奏倍率，相位错开。
- **自转**：绕 X / Y / Z 轴一直转，一圈用时吸附到能整除循环长度，顺 / 逆时针。
  烘关键帧时角度按 360 的等价类混合，循环末尾不会倒着转回去。
- **轨迹**：椭圆 / 往返 / 8 字 / 手绘，都在屏幕平面里跑，和漂浮叠加。
  「一圈用时」吸附到能整除循环长度的值，接缝才闭合。可沿路径侧倾（上限 18°）。
  手绘：视口里拖一笔，重采样 + 平滑 + 重心归零，首尾接上就绕圈，没接上就来回。
- **入场**：浮起 / 长出 / 旋入，循环结尾用同样方式退场，回到第 0 帧接缝是平的。
- **循环长度** 10 / 30 / 60 秒，60fps 烘成密集关键帧，末尾 5 秒五次多项式混回开头。
- **批量**：一次拖多个，同一套设定，相位逐个错开，打成一个 zip。
- **预览背景**：深色 / 白色 16:9 幻灯片 / 自定义色，只影响预览。

## 代码在哪

| 文件 | 干什么 |
|---|---|
| `src/lib/motion.ts` | **唯一的运动函数** `poseAt(params, t, radius)`。预览逐帧实时算，导出按 fps 采样烘。别在别处再手写公式 |
| `src/lib/drawnPath.ts` | 手绘那一笔的几何：重采样、平滑、闭环判断、Catmull-Rom 走位 |
| `src/lib/motionExport.ts` | 把姿态写进 usdz：套 Motion 层、换算坐标、占位盒、二进制根图层 |
| `src/lib/usdzScene.ts` | 加载器 + 影棚场景 + 取景，颜色校正和加动效共用 |
| `src/components/MotionPane.tsx` | 左边视口：预览、拖动转视角、手绘 |
| `src/components/MotionPanel.tsx` | 右边侧栏 |

## 文件是怎么写的（每一条都是撞出来的）

1. **在原模型外面套一层 `def Xform "Motion"`**，动画只写这一层，原模型自己的变换一个字不动。
   `defaultPrim` 改指 Motion，根节点下的绝对路径（`</Root/Materials/X>`）跟着搬。
   - 为什么不直接写进根节点：带后缀的 xformOp（`xformOp:translate:motion`）苹果会整层放弃，
     见 `usdaCompat.ts`；不带后缀又会和原模型已有的 op 重名。
2. **三个 op：`translate`、`orient`（四元数）、`scale`**（只在入场用到缩放时写）。
   - 旋转必须是 `quatf xformOp:orient`，不能是 `rotateXYZ`：旋入那一整圈写到 360° Keynote 就不播了。
     苹果自家工具导出的旋转动画全是 orient。相邻帧四元数逐帧翻成同号，插值才走短路。
   - 绕包围盒中心转的补偿折进每帧的平移：T = d + c − R·c。第三方模型的原点经常在脚底或某个角上。
3. **每个 op 除了 timeSamples 还写一个等于第 0 帧的默认值**。Keynote 开始播放前显示的是默认值，
   不写就是原大原位，一开播跳到第 0 帧 —— 长出会先看到模型缩没再长出来。
4. **占位盒 `MotionBounds`**：Motion 外面放一个不动的 Mesh，只有 8 个顶点和一个零面积的面，
   `extent` 是整段运动扫过的范围。Keynote 按第 0 帧的包围盒定镜头，长出第 0 帧缩放是 0.001，
   没有它镜头会怼进模型肚子里。
5. **预览坐标 → 文件坐标**：加载器给模型套了 metersPerUnit 缩放和 Z-up 转 Y-up 的旋转（G），
   导出按 F = G⁻¹·M·G 换算回去。Y-up 文件旋转直接照抄角度不分解（three 的 ZYX 分解把 Y 限在 ±90°）。
6. **根图层是二进制 .usdc 的包**（高达这类）：另写一个 `motion.usda` 放在包第一位当根图层，
   `def "scene" (references = @./scene.usdc@</scene>)` 把原来的引用进来。upAxis / metersPerUnit
   只认根图层的，用 three 的 crate 解析器从二进制里读出来抄过去。Keynote 认这种引用。
7. **原模型自带的动画**：根节点上的会被去掉（替换），更深处的数出来在状态里提示叠加。

## Keynote 实测规律（都验证过）

- 能循环播放 `timeSamples` 动画；60fps 密集帧没问题，1801 帧的文本关键帧才 100 多 KB。
- 按**第 0 帧**的包围盒定镜头 → 占位盒。
- 播放前显示 op 的**默认值** → 默认值写成第 0 帧。
- `rotateXYZ` 写到 360° 不播 → 用 `orient`。
- 文本根图层 reference 二进制 .usdc → 认。
- **材质动画完全不认**：`opacity` / `emissiveColor` / `diffuseColor` / 贴图节点 `inputs:scale` 加
  timeSamples 全都不动，连播放按钮都没有；和漂浮叠一起时也只播漂浮。淡入淡出、呼吸发光这类
  只能靠 Keynote 自己的构建效果，别再往文件里试。
- 曾以为 Keynote 会对 3D 对象固定淡入一秒 —— 错的，那是上一页「神奇移动」带来的渐变。

## 导出视频

管线从 3D 项目（`~/Documents/3D`）搬来：视口逐帧按 `bakeMotion` 的姿态渲染成透明 PNG，
ffmpeg.wasm 在浏览器里编 ProRes 4444 XQ（`prores_ks -profile:v 5 -pix_fmt yuva444p10le`），
厂商标记从 FFMP 改成 apl0。时长 = 循环长度，用当前视角和「取景」缩放。
代码在 `src/lib/videoExport.ts` 和 `MotionPane.tsx` 的 `frameRef.render`。
开发模式下 `@ffmpeg/ffmpeg` 必须从 Vite 预打包里排除（见 vite.config.ts）。
