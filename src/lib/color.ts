import { pwInvert } from './chart';
import cardDense from './profiles/keynote-card-dense.json';
import prismDense from './profiles/keynote-prism-dense.json';
import freeformPrismDense from './profiles/freeform-prism-dense.json';

/**
 * 颜色补偿。
 *
 * Keynote 渲染 USDZ 模型时对贴图做了两件事：色域错位（饱和色被推得更艳，
 * 饱和黄的蓝通道直接夹到 0）和一条 S 型明暗曲线（暗部压、中间提、高光收）。
 * 正向模型就是这两级串联：
 *   y = curve( M · x + offset )      x、y 都在 sRGB 编码空间的 0..1
 * 导出时把贴图套上它的逆运算，进 Keynote 正好抵消。
 */

export type Triple = [number, number, number];

export type ColorComp = {
  /** 唯一的用户开关：Keynote 颜色优化 */
  on: boolean;
  matrix: number[] | null;
  offset: Triple | null;
  /** 矩阵之后的每通道单调曲线（CURVE_K 个节点） */
  curve: number[][] | null;
  calibratedAt: string | null;
  /** 标定时实测到的样本对，用来在全局模型之上做局部修正 */
  samples: { ref: Triple; got: Triple }[] | null;
  /** 这份校准是在「关掉灯光」开着还是关着的状态下测的 —— 对不上就得重测 */
  calibratedUnlit: boolean | null;
  /** 这份校准是在多少补光下测的 —— 补光一变，整条响应曲线就变了，必须重测 */
  calibratedLift: number | null;
  /**
   * 这份校准是在哪种材质下测的。
   *
   * 2026-09-23 栽在这儿：在无边记上量补光该开多少，三轮（0 / 25% / 40%）全是在**金属**下测的，
   * 而金属的漫反射几乎为零、颜色全靠反射环境，无边记的环境又暗 —— 补光 0 时纯白只有 124，
   * 于是得出「补光不能降」的错误结论。工具当时一声不吭，因为档里只记了补光和灯光开关。
   * 补光低的时候材质对亮度的影响是压倒性的（补光高时自发光占大头，材质反而无所谓，
   * 这就是 Keynote 那边一直没暴露的原因）。老档没有这一项，是 null，按「不知道」处理，不报警。
   */
  calibratedMaterial: string | null;
};

/**
 * 内置校准档：2026-09-08 用 117 格色卡在 Keynote 里实测（USDZ 模型渲染路径、灯光开着、补光 50%、正视）。
 * 开箱即用，重新校准会覆盖它。
 *
 * **这份档是可以跨机器用的，不只对采集它的那台电脑有效。** 理由：
 * 标定时量到的数值经过两层 —— Keynote 的变换（软件行为）和显示器色彩管理 / 截图链路。
 * 但补偿的目标（「看起来和屏幕上的原图一样」）也经过同一层色彩管理，
 * 等式两边同时出现就被约掉了，剩下的是纯粹的 Keynote 变换。
 * 实测佐证：一张文件值为 161,11,0 的图，在系统预览窗口和 Keynote 里截出来都是 161,20,0 ——
 * 那 9 点绿是截图链路加的，对 2D 和 3D 一视同仁，所以会自己抵消。
 *
 * 真正需要重新标定的情况：换 Keynote 大版本、或者改了补光 / 灯光开关
 * （那会改变响应曲线本身，不是显示层的事）。
 *
 * 117 个锚点 = 8 灰阶 + 60 色彩立方体 + 12 记忆色 + 6 暗部补点 + 30 动态探针 + 1 对齐校验。
 * （之前那份有 175 个，多出来的是历次闭环微调累积的实测点；补光从拉满改成 75% 之后，
 * 那些点是在旧条件下测的，已经失效，所以这份是干净的一轮色卡。）
 *
 * 换掉上一份 70 格档的原因：3×3×3 的色彩立方体相邻样本差 128 阶，高饱和区整段没有实测
 * 支撑，蓝色系画面在 Keynote 里明显发黄 —— 一张蓝图的主色离最近的锚点有 60 阶开外，
 * 而局部修正的作用半径只有 18 阶，等于全靠全局公式外推。加密到 4×4×4（85 阶间距）之后
 * 拟合残差从 13.9 阶降到 12.2 阶，实拍对比确认蓝色已经能正确还原。
 * 动态探针按明暗分布挑色，覆盖亮度 12~252，不是取「出现最多的颜色」（那样会全挤在暗部）。
 */
/** 扁平的 [写进去 r,g,b, 量回来 r,g,b] × n → 样本对 */
function unflatSamples(flat: number[]): { ref: Triple; got: Triple }[] {
  const out: { ref: Triple; got: Triple }[] = [];
  for (let i = 0; i < flat.length; i += 6) {
    out.push({ ref: [flat[i], flat[i + 1], flat[i + 2]], got: [flat[i + 3], flat[i + 4], flat[i + 5]] });
  }
  return out;
}

/**
 * 棱柱模式的 Keynote 内置档：2026-09-13 用棱柱形状的**密集色卡**实测 ——
 * 3 张 24×16 的色卡、1130 个实测点，Keynote 14.5、灯光开着、补光 50%、正视。
 * 数据在 profiles/keynote-prism-dense.json（用户实拍导出的档，原样烧入）。
 * 上面注释里那份 117 格档已被它取代；117 格相邻 85 阶，格点之间靠外推，换图就可能差几阶。
 *
 * 值得记一笔：这份和卡片那份（keynote-card-dense.json）数值几乎一样，矩阵和实测点只差 ±1。
 * 说明 Keynote 对两种形状的响应本身相同 —— 之前「卡片比棱柱更暗更橙 20~40 阶」
 * 主要是当时那份量错的档造成的，不是几何。两份都实测过了，各用各的，不再互相沿用。
 */
export const BUILT_IN_PROFILE = {
  matrix: prismDense.matrix,
  offset: prismDense.offset as Triple,
  curve: prismDense.curve,
  samples: unflatSamples(prismDense.samples),
  label: '内置（密集 1130 格实测）',
};

export const DEFAULT_COMP: ColorComp = {
  on: true,
  matrix: BUILT_IN_PROFILE.matrix,
  offset: BUILT_IN_PROFILE.offset,
  curve: BUILT_IN_PROFILE.curve,
  calibratedAt: BUILT_IN_PROFILE.label,
  samples: BUILT_IN_PROFILE.samples,
  calibratedUnlit: false,
  calibratedMaterial: 'paper',
  // 补光 50%，不是拉满。三档实测下来纯白**始终是 244**（100%/75%/50% 纹丝不动），
  // 说明 244 是 Keynote 色调曲线的硬顶，跟补光无关 —— 那就没必要多给自发光。
  // 自发光不随角度变化，加得越多明暗越平，砍掉一半等于白赚这部分立体感。
  // 残差：100% 是 12.2 阶、75% 是 12.5、50% 是 12.8，差异不到 1/255，肉眼不可辨，
  // 拿它换立体感是划算的。这一档实拍验证过：导进 Keynote 颜色正确。
  calibratedLift: 0.5,
};

/**
 * **卡片模式**的 Keynote 内置档：2026-09-13 用卡片形状的**密集色卡**实测 ——
 * 3 张 24×16 的色卡、1130 个实测点（10×10×10 立方体 + 记忆色 + 暗部补点 + 低饱和半步点），
 * Keynote 14.5、灯光开着、补光 50%、正视，卡片 1920 px 宽、6 mm 厚。
 * 数据太大不放在代码里，见 profiles/keynote-card-dense.json（用户实拍导出的档，原样烧入）。
 *
 * 为什么卡片要单独一份：卡片的背面和四条窄边都跟着正面走，Keynote 的环境反射会把
 * 这些面染到正面上，实测一张铜色卡片比棱柱那份档预测的「更暗更橙」20~40 阶 ——
 * 拿棱柱档给卡片用，标多少次都对不上。**换模型类型就要换档。**
 *
 * 为什么是密集档：117 格相邻 85 阶、局部修正半径 18 阶，格点之间靠全局公式外推，
 * 换一张色调不同的图就可能差几阶，用户就得再标一次。1130 个点相邻 28 阶，整个色域
 * 都有实测兜底，换任何图直接导。
 */
export const BUILT_IN_CARD_PROFILE = {
  matrix: cardDense.matrix,
  offset: cardDense.offset as Triple,
  curve: cardDense.curve,
  samples: unflatSamples(cardDense.samples),
  label: '内置·卡片（密集 1130 格实测）',
};

/** 卡片模式下 Keynote 的出厂档，条件和棱柱那份一样：灯光开着、补光 50% */
export const CARD_COMP: ColorComp = {
  on: true,
  matrix: BUILT_IN_CARD_PROFILE.matrix,
  offset: BUILT_IN_CARD_PROFILE.offset,
  curve: BUILT_IN_CARD_PROFILE.curve,
  calibratedAt: BUILT_IN_CARD_PROFILE.label,
  samples: BUILT_IN_CARD_PROFILE.samples,
  calibratedUnlit: false,
  calibratedLift: 0.5,
  calibratedMaterial: 'paper',
};

/**
 * 无边记的内置校准档：2026-09-23 用户实拍的**密集 1130 格**档 ——
 * 3 张 24×16 色卡，棱柱 + 纸张 + **补光 0** + 灯光开着、正视。残差 **4.2 阶**，纯白 226，
 * 光照不均 0 阶。数据在 profiles/freeform-prism-dense.json（原样烧入）。
 *
 * **它比 Keynote 那份准三倍**（4.2 阶对 12.2 阶）。原因看矩阵就懂：对角 0.835/0.835/0.821、
 * 非对角最大 0.03，几乎就是「整体乘 0.83 再抬一点黑」，没有 Keynote 那种通道之间的混合
 * （Keynote 有个 -0.4 量级的项，饱和黄的蓝通道直接被压到 0）。
 *
 * **补光是 0，不是 50%。** 这是 2026-09-23 一整轮实测挑出来的，也是无边记真正强过 Keynote 的地方：
 * Keynote 的纯白顶死在 244，必须靠自发光顶上去，代价是明暗被压平；无边记纸张下光靠漫反射
 * 纯白就有 226，再加满补光也只多买约 20 阶上限，却要把各个面之间的明暗差压平 —— 不划算。
 * 补光 0 = 自发光一点不加 = 立体感完整保留，而颜色反而是所有档里最准的。
 *
 * 走过的弯路记在 KEYNOTE-COLOR.md：这一轮先在**金属**材质下测了 0 / 25% / 40% 三档
 * （纯白只有 124 / 179 / 195），差点得出「无边记不能降补光」的反结论 —— 金属漫反射几乎为零、
 * 全靠反射环境，而无边记环境很暗。材质现在是校准条件的一部分（`calibratedMaterial`）。
 *
 * 上一份 2026-09-08 的 117 格档已被取代：那份是补光 50%、117 个点、相邻 85 阶，格点之间靠外推。
 */
export const FREEFORM_PROFILE = {
  matrix: freeformPrismDense.matrix,
  offset: freeformPrismDense.offset as Triple,
  curve: freeformPrismDense.curve,
  samples: unflatSamples(freeformPrismDense.samples),
  label: '内置（密集 1130 格实测）',
};

/** 无边记的出厂档。它自带的补光是 **0**，和 Keynote 那份（50%）不一样 */
export const FREEFORM_COMP: ColorComp = {
  on: true,
  matrix: FREEFORM_PROFILE.matrix,
  offset: FREEFORM_PROFILE.offset,
  curve: FREEFORM_PROFILE.curve,
  calibratedAt: FREEFORM_PROFILE.label,
  samples: FREEFORM_PROFILE.samples,
  calibratedUnlit: false,
  // 补光 0，不是 50% —— 这是 2026-09-23 实测挑出来的，也是无边记真正强过 Keynote 的地方。
  // 切目标时补光要跟着档走：这不是偏好，是校准的前提条件（见 App 里的 switchProfile）。
  calibratedLift: 0,
  calibratedMaterial: 'paper',
};

/**
 * 还没校准过的空档 —— 给 Keynote 以外的目标 App 用。
 * matrix 为 null 时 isIdentity 成立，等于不做任何补偿，导出的就是原图。
 */
export const BLANK_COMP: ColorComp = {
  on: true,
  matrix: null,
  offset: null,
  curve: null,
  calibratedAt: null,
  samples: null,
  calibratedUnlit: null,
  calibratedLift: null,
  calibratedMaterial: null,
};

export function isIdentity(c: ColorComp): boolean {
  return !c.on || !c.matrix;
}

/**
 * 校准参数本身的指纹。不含 `on` —— 缓存正向模型时要的是「这份校准长什么样」，
 * 用 compSignature 会把所有关掉补偿的档案都算成同一个 'off'，模型缓存就会串档。
 */
function fingerprint(c: ColorComp): string {
  if (!c.matrix) return 'none';
  return [
    c.matrix.map((v) => v.toFixed(4)).join(','),
    (c.offset ?? []).map((v) => v.toFixed(4)).join(','),
    (c.curve ?? []).flat().map((v) => v.toFixed(4)).join(','),
    (c.samples ?? []).map((s) => s.ref.join('') + '>' + s.got.map(Math.round).join('')).join(';'),
  ].join('|');
}

/** 补偿参数的指纹，用来判断烘焙缓存是否失效 */
export function compSignature(c: ColorComp): string {
  return isIdentity(c) ? 'off' : fingerprint(c);
}

const pwEval = (t: number, y: number[]) => {
  const K = y.length;
  if (t <= 0) return y[0];
  if (t >= 1) return y[K - 1];
  const s = t * (K - 1);
  const i = Math.min(K - 2, Math.floor(s));
  return y[i] * (1 - (s - i)) + y[i + 1] * (s - i);
};

/**
 * 局部修正的作用半径（归一化 RGB 距离）。0.07 约合 18 阶。
 */
export const LOCAL_SIGMA = 0.07;

/**
 * 岭正则项。λ→0 时修正场会严格穿过每一个实测点，但截图量出来的颜色本身带 ±1 阶噪声
 * （抗锯齿 + 量化），严格插值会把噪声一起放大 —— 实测里连打三轮微调之后反而跳回十几阶。
 * 1e-2 下实测点的复现残差是 0.35~0.57 阶（肉眼不可见），同时对噪声稳定。
 */
const LOCAL_RIDGE = 1e-2;

/** 距离超过 √24·σ ≈ 4.9σ 的样本权重只剩 6e-6，直接跳过 —— 求值快 3 倍 */
const LOCAL_CUTOFF2 = 24 * LOCAL_SIGMA * LOCAL_SIGMA;

/**
 * 解出高斯径向基的权重：找一组 a，使得 Σ aⱼ·exp(-|xᵢ-xⱼ|²/2σ²) 在每个实测点上
 * 都正好等于那里的残差。核矩阵对称正定，加上岭正则之后必然可解。
 *
 * 一次性 n³ 的消元（56 个色块约 0.2 ms），换来的是求值时和加权均值完全同样的开销。
 */
function solveRbfWeights(pts: { ref: Triple; res: Triple }[]): number[][] | null {
  const n = pts.length;
  const denom = 2 * LOCAL_SIGMA * LOCAL_SIGMA;
  const m: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(n + 3);
    for (let j = 0; j < n; j++) {
      const a = pts[i].ref;
      const b = pts[j].ref;
      const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      row[j] = Math.exp(-d2 / denom);
    }
    row[i] += LOCAL_RIDGE;
    row[n] = pts[i].res[0];
    row[n + 1] = pts[i].res[1];
    row[n + 2] = pts[i].res[2];
    m.push(row);
  }
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    if (piv !== c) {
      const t = m[c];
      m[c] = m[piv];
      m[piv] = t;
    }
    const pc = m[c];
    const inv = 1 / pc[c];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] * inv;
      if (f === 0) continue;
      const rr = m[r];
      for (let k = c; k < n + 3; k++) rr[k] -= f * pc[k];
    }
  }
  const w = [new Array<number>(n), new Array<number>(n), new Array<number>(n)];
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) w[ch][i] = m[i][n + ch] / m[i][i];
  return w;
}

/**
 * 正向模型 = 全局的「矩阵 + 曲线」，再叠一层实测点的局部修正。
 *
 * 全局模型只有 27 个参数，要同时照顾 56 个色块，在任何一个局部都会妥协 ——
 * 而饱和暖色的蓝通道恰好是个极陡的过渡区（多写 40 就从 0 冲到 108），
 * 妥协的代价在那里被放得很大。局部修正让模型在实测过的颜色上精确复现，
 * 离得远的地方权重自然衰减回全局模型。
 *
 * 局部修正用的是**径向基插值**，不是高斯加权均值。均值只会把附近的残差平均一下，
 * 实测点自己也被邻居拉走，所以在实测点上根本复现不准；而闭环微调连打几轮之后
 * 锚点必然扎堆，均值就把它们糊成一团。实测对比（扎堆锚点上的最大残差）：
 *
 *   高斯加权均值   6.98 阶
 *   移动最小二乘   3.68 阶
 *   径向基插值     0.35 阶
 *
 * 移动最小二乘（局部线性回归）确实能带上斜率，但每次求值要解一个 4×4，实测慢 4.8 倍，
 * 而且它仍然是「拟合」不是「插值」，锚点照样复现不准。径向基把解方程挪到了建表那一次，
 * 求值退化成一次加权求和，和原来的均值一样便宜。
 */
let fwdCacheKey = '';
let fwdCacheVal: ((rgb: Triple) => Triple) | null = null;

function forwardModel(c: ColorComp): (rgb: Triple) => Triple {
  const cacheKey = fingerprint(c);
  if (cacheKey === fwdCacheKey && fwdCacheVal) return fwdCacheVal;

  const M = c.matrix!;
  const off = c.offset ?? [0, 0, 0];
  const curve = c.curve;
  const global = (v: Triple): Triple => {
    const out: Triple = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const p = M[ch * 3] * v[0] + M[ch * 3 + 1] * v[1] + M[ch * 3 + 2] * v[2] + off[ch];
      const q = Math.max(0, Math.min(1, p));
      out[ch] = curve ? pwEval(q, curve[ch]) : q;
    }
    return out;
  };

  let fn = global;
  const samples = c.samples ?? [];
  if (samples.length > 0) {
    const pts = samples.map((s) => {
      const ref: Triple = [s.ref[0] / 255, s.ref[1] / 255, s.ref[2] / 255];
      const g = global(ref);
      return {
        ref,
        res: [s.got[0] / 255 - g[0], s.got[1] / 255 - g[1], s.got[2] / 255 - g[2]] as Triple,
      };
    });
    const W = solveRbfWeights(pts);
    if (W) {
      const denom = 2 * LOCAL_SIGMA * LOCAL_SIGMA;
      const n = pts.length;
      const xs = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        xs[i * 3] = pts[i].ref[0];
        xs[i * 3 + 1] = pts[i].ref[1];
        xs[i * 3 + 2] = pts[i].ref[2];
      }
      const [wr, wg, wb] = W;
      fn = (v: Triple): Triple => {
        const g = global(v);
        let r = 0;
        let gg = 0;
        let b = 0;
        for (let i = 0; i < n; i++) {
          const o = i * 3;
          const d2 = (v[0] - xs[o]) ** 2 + (v[1] - xs[o + 1]) ** 2 + (v[2] - xs[o + 2]) ** 2;
          if (d2 > LOCAL_CUTOFF2) continue;
          const k = Math.exp(-d2 / denom);
          r += k * wr[i];
          gg += k * wg[i];
          b += k * wb[i];
        }
        return [g[0] + r, g[1] + gg, g[2] + b];
      };
    }
  }
  fwdCacheKey = cacheKey;
  fwdCacheVal = fn;
  return fn;
}

const LUT_N = 17;
const lutCache = new Map<string, Uint8Array>();

/**
 * 反解成 3D LUT。
 *
 * 「无约束反解再逐通道截断」会让色相跑偏 —— 红色顶到 255 截断、蓝色算出负数截断，
 * 出来就是个偏色的怪颜色。这里改成带约束的迭代搜索：每一步都夹在可写范围内，
 * 收敛到的是「在能写进 8 位贴图的颜色里，进 Keynote 之后最接近目标的那个」。
 */
type Solver = (target: Triple) => Triple;

/** 造一个「给定想要的外观，解出该写什么」的求解器（0..1 空间） */
function makeSolver(c: ColorComp): Solver {
  const fwd = forwardModel(c);
  const inv = invert3(c.matrix!)!;
  const curve = c.curve;
  const off = c.offset ?? [0, 0, 0];
  const curveInv = (y: number, ch: number) => (curve ? pwInvert(y, curve[ch]) : y);
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  return (target: Triple): Triple => {
    const t0: Triple = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) t0[ch] = curveInv(target[ch], ch) - off[ch];
    let x: Triple = [
      clamp01(inv[0] * t0[0] + inv[1] * t0[1] + inv[2] * t0[2]),
      clamp01(inv[3] * t0[0] + inv[4] * t0[1] + inv[5] * t0[2]),
      clamp01(inv[6] * t0[0] + inv[7] * t0[1] + inv[8] * t0[2]),
    ];
    // 三通道等权：sRGB 编码空间的差值本来就大致等价于感知差异
    const errOf = (v: Triple) => {
      const y = fwd(v);
      return (y[0] - target[0]) ** 2 + (y[1] - target[1]) ** 2 + (y[2] - target[2]) ** 2;
    };
    let best = x;
    let bestErr = Infinity;
    for (let it = 0; it < 12; it++) {
      const y = fwd(x);
      const err = errOf(x);
      if (err < bestErr) {
        bestErr = err;
        best = x;
      }
      const d: Triple = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) d[ch] = curveInv(target[ch], ch) - curveInv(clamp01(y[ch]), ch);
      x = [
        clamp01(x[0] + inv[0] * d[0] + inv[1] * d[1] + inv[2] * d[2]),
        clamp01(x[1] + inv[3] * d[0] + inv[4] * d[1] + inv[5] * d[2]),
        clamp01(x[2] + inv[6] * d[0] + inv[7] * d[1] + inv[8] * d[2]),
      ];
    }
    // 牛顿步是按全局公式推的，局部修正一强方向就不准。收尾用逐坐标细搜，
    // 直接对含局部修正的真实模型下降，保证收敛。
    for (const step of [16 / 255, 6 / 255, 2 / 255, 1 / 255, 0.4 / 255]) {
      let moved = true;
      while (moved) {
        moved = false;
        for (let ch = 0; ch < 3; ch++) {
          for (const dir of [1, -1]) {
            const trial: Triple = [best[0], best[1], best[2]];
            trial[ch] = clamp01(trial[ch] + dir * step);
            if (trial[ch] === best[ch]) continue;
            const e = errOf(trial);
            if (e < bestErr - 1e-12) {
              bestErr = e;
              best = trial;
              moved = true;
            }
          }
        }
      }
    }
    return best;
  };
}

function buildInverseLUT3D(c: ColorComp): Uint8Array {
  const key = compSignature(c);
  const hit = lutCache.get(key);
  if (hit) return hit;

  const solve1 = makeSolver(c);

  const lut = new Uint8Array(LUT_N * LUT_N * LUT_N * 3);
  for (let bi = 0; bi < LUT_N; bi++) {
    for (let gi = 0; gi < LUT_N; gi++) {
      for (let ri = 0; ri < LUT_N; ri++) {
        const best = solve1([ri / (LUT_N - 1), gi / (LUT_N - 1), bi / (LUT_N - 1)]);
        const o = ((bi * LUT_N + gi) * LUT_N + ri) * 3;
        lut[o] = Math.round(best[0] * 255);
        lut[o + 1] = Math.round(best[1] * 255);
        lut[o + 2] = Math.round(best[2] * 255);
      }
    }
  }
  if (lutCache.size > 4) lutCache.clear();
  lutCache.set(key, lut);
  return lut;
}

function lutSample(lut: Uint8Array, r: number, g: number, b: number): Triple {
  const s = (LUT_N - 1) / 255;
  const fr = r * s;
  const fg = g * s;
  const fb = b * s;
  const r0 = Math.min(LUT_N - 2, Math.floor(fr));
  const g0 = Math.min(LUT_N - 2, Math.floor(fg));
  const b0 = Math.min(LUT_N - 2, Math.floor(fb));
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const out: Triple = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let acc = 0;
    for (let i = 0; i < 8; i++) {
      const wr = i & 1 ? dr : 1 - dr;
      const wg = i & 2 ? dg : 1 - dg;
      const wb = i & 4 ? db : 1 - db;
      const o = (((b0 + (i & 4 ? 1 : 0)) * LUT_N + (g0 + (i & 2 ? 1 : 0))) * LUT_N + (r0 + (i & 1))) * 3;
      acc += wr * wg * wb * lut[o + ch];
    }
    out[ch] = acc;
  }
  return out;
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const s = 1 / det;
  return [
    (e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
export const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;

/**
 * 「想要这个外观，该往贴图 / 材质里写什么」—— 0..255 进、0..255 出。
 *
 * 贴图像素、端面纯色、色卡上的动态探针格全都走这一个入口。三处必须是同一个值，
 * 否则界面上预告的、色卡上量的、和文件里真正写进去的会是三个不同的数。
 */
export function solveWritten(r: number, g: number, b: number, c: ColorComp): Triple {
  if (isIdentity(c)) return [r, g, b];
  const v = makeSolver(c)([r / 255, g / 255, b / 255]);
  return v.map((x) => Math.max(0, Math.min(255, Math.round(x * 255)))) as Triple;
}

/**
 * 端面是纯色材质，没有贴图可烘，补偿直接写成材质的线性色。
 *
 * 走的是和侧面贴图同一个带约束求解器，不是「公式反解再逐通道截断」——
 * 截断会让色相跑偏（红顶到 255、蓝算出负数，两个通道被砍的比例不一样），
 * 而且旧路径完全绕开了局部修正，闭环微调锚上去的点对端面一点用都没有。
 *
 * 值域和侧面一样夹在 0..255：模型本来就只在 0..1 上拟合过，
 * 「纯色可以写 > 1」是模型定义域外的外推，没有实测支撑。真正抬高天花板的是补光。
 */
export function compensateToLinear(hex: string, c: ColorComp): Triple | null {
  if (isIdentity(c)) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const w = solveWritten((n >> 16) & 255, (n >> 8) & 255, n & 255, c);
  return [srgbToLinear(w[0] / 255), srgbToLinear(w[1] / 255), srgbToLinear(w[2] / 255)];
}


/** 就地把补偿应用到一整块像素上 */
/**
 * 占比大的颜色单独精确求解，其余走三维查找表。
 *
 * 查找表是 17³ 的网格 + 三线性插值，在响应陡峭的区间（比如暗红）插值误差有好几阶 —— 
 * 闭环微调每次都卡在差几阶，就是卡在这里。纯色块和大面积主色根本不需要插值，
 * 直接解就行；照片里的散碎像素才用查找表，那里差一两阶看不出来。
 */
export function applyToImageData(data: Uint8ClampedArray, c: ColorComp) {
  if (isIdentity(c)) return;
  const lut = buildInverseLUT3D(c);
  const total = data.length / 4;

  // 直方图是用来找「占面积大的几种颜色」的，那种颜色不可能只出现在零星几个像素上，
  // 所以大图隔几个像素采一次就够。逐个像素建表的话，一张 840 万像素的照片
  // 会撑出上百万条记录 —— 又慢又占内存，实测是整条校正链路里最大的一块开销。
  const stride = total > 400_000 ? 8 : 1;
  const step = stride * 4;
  const sampled = Math.max(1, Math.floor(total / stride));
  const hist = new Map<number, number>();
  for (let i = 0; i < data.length; i += step) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const exact = new Map<number, Triple>();
  const hot = [...hist.entries()]
    .filter(([, n]) => n >= sampled * 0.004)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 48);
  if (hot.length > 0) {
    const solve1 = makeSolver(c);
    for (const [k] of hot) {
      const v = solve1([((k >> 16) & 255) / 255, ((k >> 8) & 255) / 255, (k & 255) / 255]);
      exact.set(k, [
        Math.max(0, Math.min(255, Math.round(v[0] * 255))),
        Math.max(0, Math.min(255, Math.round(v[1] * 255))),
        Math.max(0, Math.min(255, Math.round(v[2] * 255))),
      ]);
    }
  }

  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const e = exact.get(k);
    if (e) {
      data[i] = e[0];
      data[i + 1] = e[1];
      data[i + 2] = e[2];
      continue;
    }
    const v = lutSample(lut, data[i], data[i + 1], data[i + 2]);
    data[i] = Math.round(v[0]);
    data[i + 1] = Math.round(v[1]);
    data[i + 2] = Math.round(v[2]);
  }
}

const fwdLutCache = new Map<string, Uint8Array>();

/** 正向模型的 3D LUT。和反解那张是一个结构，只是方向反过来 */
function buildForwardLUT3D(c: ColorComp): Uint8Array {
  const key = compSignature(c);
  const hit = fwdLutCache.get(key);
  if (hit) return hit;
  const fwd = forwardModel(c);
  const lut = new Uint8Array(LUT_N * LUT_N * LUT_N * 3);
  for (let bi = 0; bi < LUT_N; bi++) {
    for (let gi = 0; gi < LUT_N; gi++) {
      for (let ri = 0; ri < LUT_N; ri++) {
        const y = fwd([ri / (LUT_N - 1), gi / (LUT_N - 1), bi / (LUT_N - 1)]);
        const o = ((bi * LUT_N + gi) * LUT_N + ri) * 3;
        for (let k = 0; k < 3; k++) lut[o + k] = Math.max(0, Math.min(255, Math.round(y[k] * 255)));
      }
    }
  }
  if (fwdLutCache.size > 4) fwdLutCache.clear();
  fwdLutCache.set(key, lut);
  return lut;
}

/**
 * 就地把一张图变成「它在 Keynote 里会显示成的样子」。
 *
 * 逐像素跑 forwardOf 会很慢（每个像素都要过一遍 70 个高斯基），所以走 LUT ——
 * 和 applyToImageData 用的是同一套结构，只是方向相反。
 */
export function applyForwardToImageData(data: Uint8ClampedArray, c: ColorComp) {
  if (isIdentity(c)) return;
  const lut = buildForwardLUT3D(c);
  for (let i = 0; i < data.length; i += 4) {
    const v = lutSample(lut, data[i], data[i + 1], data[i + 2]);
    data[i] = Math.round(v[0]);
    data[i + 1] = Math.round(v[1]);
    data[i + 2] = Math.round(v[2]);
  }
}

export function applyToHex(hex: string, c: ColorComp): string {
  if (isIdentity(c)) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  // 单色不走查找表，直接精确解
  const v = solveWritten((n >> 16) & 255, (n >> 8) & 255, n & 255, c);
  return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 正向：往贴图里写这个值，预计在 Keynote 里显示成什么。0..255 进、0..255 出。
 *
 * 这是模型的正向出口，和 `solveWritten`（反解）配成一对。
 * 局部修正是「插值」而不是「加权平均」这件事，只能从这个方向验证 ——
 * 在每一个实测点上，它的输出必须等于当初量到的值。
 */
export function forwardOf(r: number, g: number, b: number, c: ColorComp): Triple {
  if (isIdentity(c)) return [r, g, b];
  const y = forwardModel(c)([r / 255, g / 255, b / 255]);
  return y.map((v) => Math.max(0, Math.min(255, Math.round(v * 255)))) as Triple;
}

/** 给界面看的：这个颜色补偿之后，预计在 Keynote 里会变成什么 */
export function predictKeynote(hex: string, c: ColorComp): string | null {
  if (isIdentity(c)) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const w = makeSolver(c)([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
  const y = forwardModel(c)(w);
  return `#${y
    .map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}
