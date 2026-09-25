import * as THREE from 'three';
// @ts-expect-error 从 three r185 搬过来的加载器，没有类型声明
import { USDLoader } from '../vendor/USDLoader.js';
import { STUDIO_ENV_INTENSITY, makeStudioEnvironment } from './studioEnv';

/**
 * 「拿现成的 usdz 来看」的公共部分：颜色校正的前后对比和加动效的预览都用它。
 *
 * 加载一个 usdz，**等到贴图真正解码完**才 resolve。
 *
 * 关键是必须走 onLoad 回调：`parse()` 本身是同步的，它建好几何和材质就立刻返回，
 * 贴图是另一条异步链（Blob → Image → onload 才把 image 挂到 texture 上）。
 * 加载器只有在收到 onLoad 时才会去等自己那批 texturePromises —— 直接
 * `await loader.parse(...)` 等于没等，拿到的模型上每个 map 都还是空的，
 * 渲染出来整个模型是黑的（贴图槽有值、内容是空的，采样结果就是黑）。
 */
export function loadUsdz(buf: ArrayBuffer): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new USDLoader().parse(buf, '', resolve, reject);
  });
}

/**
 * 不渲染，只量：加载器给模型套的变换和包围盒（three 世界坐标）。
 * 批量加动效时，除了正在预览的那个，其余文件都靠这个拿到导出要的空间信息。
 */
export async function measureUsdz(buf: ArrayBuffer): Promise<{
  groupMatrix: number[];
  min: [number, number, number];
  max: [number, number, number];
  animationDuration?: number;
}> {
  const obj = await loadUsdz(buf);
  obj.updateMatrix();
  const box = new THREE.Box3().setFromObject(obj);
  return {
    groupMatrix: obj.matrix.toArray(),
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
    animationDuration: Math.max(0, ...obj.animations.map((clip) => clip.duration)) || undefined,
  };
}

/**
 * 一个挂好影棚环境和布光的空场景，模型放进 pivot 里。
 * transparent：要逐帧抓透明 PNG 的（导视频）开这个 —— 带 alpha、不预乘、保留绘制缓冲。
 */
export function makeScene(container: HTMLDivElement, opts: { transparent?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer(
    opts.transparent
      ? { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true }
      : { antialias: true, alpha: false },
  );
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  // 别人的模型什么材质都有。金属只反射环境，没环境就一片黑 —— 用户导入一块
  // 金属度 1 的长方体，预览里只剩个暗红影子，就是栽在这里。挂上按 Keynote 拟合的影棚环境，
  // 强度也用同一份，两边看起来才是一回事。
  const env = makeStudioEnvironment(renderer);
  scene.environment = env;
  scene.environmentIntensity = STUDIO_ENV_INTENSITY;
  // 和主视口同一套布光，免得两边看起来不是一回事
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2, 3, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-3, 1, 2);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
  const pivot = new THREE.Group();
  scene.add(pivot);
  return { renderer, scene, camera, pivot };
}

/**
 * 把相机摆到能把半径 radius 的球完整框住的距离上，正对原点。
 * 竖向和横向取更窄的那个视角来算，横屏竖屏都不会切边。
 */
export function frameCamera(camera: THREE.PerspectiveCamera, radius: number, margin = 1.25) {
  const vHalf = (camera.fov * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * margin;
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(0.001, dist - radius * 2);
  camera.far = dist + radius * 6;
  camera.updateProjectionMatrix();
}
