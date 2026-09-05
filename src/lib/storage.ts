import { DEFAULT_COMP } from './color';
import { DEFAULT_PARAMS, DEFAULT_TRANSFORM, MAX_SIDES, type FaceTransform, type Params } from './types';

const KEY = 'prism-usdz-exporter/v3';

type Persisted = { params: Params; transforms: FaceTransform[] };

/** 只存参数和 face transform，图片本体不存（太大） */
export function save(params: Params, transforms: FaceTransform[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ params, transforms } satisfies Persisted));
  } catch {
    /* 隐私模式 / 配额满，忽略 */
  }
}

export function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const params = { ...DEFAULT_PARAMS, ...(parsed.params ?? {}) };
    // color 是嵌套对象，浅合并会把新加的字段丢掉
    params.color = { ...DEFAULT_COMP, ...(parsed.params?.color ?? {}) };
    // 存档里没有校准数据（被清除过，或者是旧版本存的），一律回退到内置档。
    // 否则一次「清除」会永久盖住内置档，之后代码里更新校准也永远生不了效。
    // 想彻底不补偿只有一个入口：把 on 关掉。
    if (!params.color.matrix || !params.color.curve) {
      params.color = { ...DEFAULT_COMP, on: params.color.on };
    }
    const transforms = Array.from({ length: MAX_SIDES }, (_, i) => ({
      ...DEFAULT_TRANSFORM,
      ...(parsed.transforms?.[i] ?? {}),
    }));
    return { params, transforms };
  } catch {
    return null;
  }
}
