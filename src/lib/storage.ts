import { BLANK_COMP, DEFAULT_COMP, type ColorComp } from './color';
import { DEFAULT_PARAMS, DEFAULT_TRANSFORM, MAX_SLOTS, TARGETS, defaultProfiles, type FaceTransform, type Params, type TargetId } from './types';

/**
 * 存档键带版本号。参数结构变了（长度/粗细改成像素、分辨率换档位、端面多了镂空、
 * 底色可透明）之后，旧存档里的值对不上，硬读回来会得到一个奇怪的状态。
 * 换个键就等于旧档自然作废，从默认值重新开始。
 */
const KEY = 'prism-usdz-exporter/v5';

type Persisted = { params: Params; transforms: (FaceTransform & { hidden?: boolean })[] };

/**
 * 把存档里的一份校准档补全。
 *
 * Keynote 那份特殊：存档里没有校准数据（被清除过，或者是旧版本存的）就回退到内置档 ——
 * 否则一次「清除」会永久盖住内置档，之后代码里更新校准也永远生不了效。
 * 想彻底不补偿只有一个入口：把 on 关掉。
 * 别的目标本来就可能没校准过，空着是正常状态，不能拿 Keynote 的档去顶。
 */
function reviveComp(id: TargetId, raw: Partial<ColorComp> | undefined): ColorComp {
  const base = id === 'keynote' ? DEFAULT_COMP : BLANK_COMP;
  const merged = { ...base, ...(raw ?? {}) };
  if (id === 'keynote' && (!merged.matrix || !merged.curve)) {
    return { ...DEFAULT_COMP, on: merged.on };
  }
  return merged;
}

/** 只存参数和 face transform，图片本体不存（太大） */
export function save(params: Params, transforms: (FaceTransform & { hidden?: boolean })[]) {
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
    // 每个目标 App 一份校准档，逐份补齐字段（嵌套对象浅合并会把新加的字段丢掉）
    const saved: Partial<Record<TargetId, Partial<ColorComp>>> = parsed.params?.profiles ?? {};
    const profiles = defaultProfiles();
    for (const t of TARGETS) {
      profiles[t.id] = reviveComp(t.id, saved[t.id]);
    }
    params.profiles = profiles;
    params.target = TARGETS.some((t) => t.id === parsed.params?.target)
      ? (parsed.params!.target as TargetId)
      : 'keynote';
    params.color = profiles[params.target];
    // 材质那一套已经砍掉了。当初点材质按钮会把补光归零 —— 那是为了看质感，
    // 现在质感没了，补光得还回来，不然颜色一直是暗的、还找不到原因。
    if ('material' in (parsed.params ?? {})) {
      params.emissiveLift = DEFAULT_PARAMS.emissiveLift;
      params.emissiveExport = DEFAULT_PARAMS.emissiveExport;
      delete (params as Record<string, unknown>).material;
    }
    const transforms = Array.from({ length: MAX_SLOTS }, (_, i) => ({
      ...DEFAULT_TRANSFORM,
      ...(parsed.transforms?.[i] ?? {}),
    }));
    return { params, transforms };
  } catch {
    return null;
  }
}
