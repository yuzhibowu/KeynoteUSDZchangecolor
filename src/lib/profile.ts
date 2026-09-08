/**
 * 校准档的存取。
 *
 * 标定是有成本的事：导色卡、进 Keynote、截图、传回来。可结果一直只存在浏览器的
 * localStorage 里 —— 换台电脑、换个浏览器、清一次数据就没了，只能从头再标一遍。
 * 这个文件把校准档变成一个可以存下来、发给别人、以后再装回去的文件。
 */
import { CURVE_K } from './chart';
import { DEFAULT_COMP, type ColorComp, type Triple } from './color';

const FORMAT = 'prism-usdz-color-profile';
const VERSION = 2;

export type ProfileFile = {
  format: string;
  version: number;
  /**
   * 这份档是给哪个目标 App 标的。
   *
   * v1 没有这个字段，导出的文件名还一律写死 keynote- 前缀 —— 于是一份无边记的档
   * 看着就像 Keynote 的，装错了颜色会莫名其妙全偏，而且这是最难查的那类问题
   * （数据本身完全合法，只是测的不是这个渲染器）。v2 起记下来，导入时对不上就拦一道。
   * 读 v1 的老档时这里是 undefined，按「不知道」处理，只提示不拦。
   */
  target?: string;
  exportedAt: string;
  calibratedAt: string | null;
  /** 这份档是在多少补光下测的 —— 补光一变响应曲线就变了，装回去时要一起还原 */
  lift: number | null;
  /** 同上：「关掉灯光」开着还是关着 */
  unlit: boolean | null;
  matrix: number[];
  offset: number[];
  curve: number[][];
  /** 扁平存：每 6 个数是一组 [写进去 r,g,b, 量回来 r,g,b]，比对象数组省一半体积 */
  samples: number[];
};

export function serializeProfile(c: ColorComp, target?: string): ProfileFile {
  return {
    format: FORMAT,
    version: VERSION,
    target,
    exportedAt: new Date().toISOString(),
    calibratedAt: c.calibratedAt,
    lift: c.calibratedLift,
    unlit: c.calibratedUnlit,
    matrix: c.matrix ?? [],
    offset: c.offset ?? [0, 0, 0],
    curve: c.curve ?? [],
    samples: (c.samples ?? []).flatMap((s) => [...s.ref, ...s.got].map(Math.round)),
  };
}

export type ParseResult =
  | {
      ok: true;
      comp: Partial<ColorComp>;
      lift: number | null;
      unlit: boolean | null;
      sampleCount: number;
      /** 这份档标的是哪个目标；v1 的老档没有这个字段，是 null */
      target: string | null;
    }
  | { ok: false; reason: string };

/**
 * 解析一个校准档文件。
 *
 * 用户可能拖进来任何东西 —— 别的 JSON、截图、半截文件。所以每一项都要验，
 * 报错要说清楚是哪里不对，而不是笼统一句「格式错误」。
 */
export function parseProfile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '这不是一个 JSON 文件。校准档应该是从本工具「导出校准档」存下来的 .json' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '文件内容不是一个对象' };
  }
  const d = raw as Record<string, unknown>;

  if (d.format !== FORMAT) {
    return { ok: false, reason: '这不是本工具的校准档（缺少格式标记）' };
  }
  if (typeof d.version !== 'number' || d.version > VERSION) {
    return { ok: false, reason: `这份档是更新版本的工具导出的（v${String(d.version)}），当前版本读不了` };
  }

  const nums = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

  if (!nums(d.matrix, 9)) return { ok: false, reason: '矩阵数据缺失或损坏（应该是 9 个数）' };
  if (!nums(d.offset, 3)) return { ok: false, reason: '偏移数据缺失或损坏（应该是 3 个数）' };
  if (
    !Array.isArray(d.curve) ||
    d.curve.length !== 3 ||
    !d.curve.every((ch) => nums(ch, CURVE_K))
  ) {
    return { ok: false, reason: `曲线数据缺失或损坏（应该是 3 条、每条 ${CURVE_K} 个节点）` };
  }
  // 曲线必须单调，否则求不了逆，补偿会算出乱七八糟的值
  for (const ch of d.curve as number[][]) {
    for (let i = 1; i < ch.length; i++) {
      if (ch[i] <= ch[i - 1]) return { ok: false, reason: '曲线不是单调的，这份档没法用来反算' };
    }
  }

  if (!Array.isArray(d.samples) || d.samples.length % 6 !== 0) {
    return { ok: false, reason: '实测样本数据损坏（每组应该是 6 个数）' };
  }
  const flat = d.samples as unknown[];
  if (!flat.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 255)) {
    return { ok: false, reason: '实测样本里有超出 0–255 的值' };
  }
  const samples: { ref: Triple; got: Triple }[] = [];
  for (let i = 0; i < flat.length; i += 6) {
    const v = flat.slice(i, i + 6) as number[];
    samples.push({ ref: [v[0], v[1], v[2]], got: [v[3], v[4], v[5]] });
  }

  return {
    ok: true,
    sampleCount: samples.length,
    target: typeof d.target === 'string' ? d.target : null,
    lift: typeof d.lift === 'number' ? d.lift : null,
    unlit: typeof d.unlit === 'boolean' ? d.unlit : null,
    comp: {
      on: true,
      matrix: d.matrix as number[],
      offset: d.offset as Triple,
      curve: d.curve as number[][],
      samples,
      calibratedAt: typeof d.calibratedAt === 'string' ? d.calibratedAt : '导入的档',
      calibratedLift: typeof d.lift === 'number' ? d.lift : DEFAULT_COMP.calibratedLift,
      calibratedUnlit: typeof d.unlit === 'boolean' ? d.unlit : DEFAULT_COMP.calibratedUnlit,
    },
  };
}

/**
 * 导出时的文件名：带上目标、标定时间和格数，方便存好几份对照。
 *
 * 目标一定要进文件名。原来一律写死 keynote- 前缀，于是一份无边记的档看着就像
 * Keynote 的，很容易装错 —— 而装错之后颜色会莫名其妙全偏，最难查。
 *
 * 标定时间可能是「2026/9/5 13:41」这样的日期，也可能是「内置（117 格实测）」这样的标签。
 * 只有前者才拿来做时间戳 —— 否则会从标签里抠出个数字，拼出 `-117-175格` 这种怪名字。
 */
export function profileFileName(c: ColorComp, target = 'keynote'): string {
  const at = c.calibratedAt ?? '';
  const m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{2})/.exec(at);
  const pad = (v: string) => v.padStart(2, '0');
  const stamp = m ? `${m[1]}${pad(m[2])}${pad(m[3])}-${pad(m[4])}${m[5]}` : '';
  const n = (c.samples ?? []).length;
  return `${target}-color-profile${stamp ? '-' + stamp : ''}-${n}格.json`;
}
