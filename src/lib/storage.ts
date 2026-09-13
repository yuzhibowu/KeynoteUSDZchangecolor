import { type ColorComp } from './color';
import { DEFAULT_MATERIAL, MATERIALS } from './material';
import { DEFAULT_PARAMS, DEFAULT_TRANSFORM, MAX_SLOTS, PROFILE_KEYS, TARGETS, defaultProfiles, profileKey, type FaceTransform, type Params, type ProfileKey, type TargetId } from './types';

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
export function reviveComp(id: ProfileKey, raw: Partial<ColorComp> | undefined): ColorComp {
  // 每个目标的出厂默认都从 defaultProfiles 拿，别在这儿再写一份
  const base = defaultProfiles()[id];
  const merged = { ...base, ...(raw ?? {}) };
  // 存档里没有校准数据（被清除过，或者是旧版本存的）就回退到出厂档 ——
  // 否则一次「清除」会永久盖住内置档，之后代码里更新校准也永远生不了效。
  // 想彻底不补偿只有一个入口：把 on 关掉。
  // 现在两个目标都有真正实测的出厂档了，所以这条对它们一视同仁（原来只护着 Keynote）。
  if (!merged.matrix || !merged.curve) {
    return { ...base, on: merged.on };
  }
  // 存档里是**旧版内置档**（标签写着「内置」，但矩阵/曲线和现在代码里的对不上）：
  // 也换成当前内置档。否则 70 格、175 格那些老档会一直盖住新的 117 格档，
  // 用户根本不知道自己一直在用旧标定，只觉得「怎么还是不准」——
  // 只有手点「恢复内置校准」才换过来，实测就栽在这里。
  // 用户在当前内置档上做过闭环微调的（标签不变、只多了 samples）矩阵是一样的，不会被误伤。
  if (isBuiltInLabel(merged.calibratedAt) && !sameCalibration(merged, base)) {
    return { ...base, on: merged.on };
  }
  return merged;
}

const isBuiltInLabel = (label: string | null | undefined) => !!label && label.startsWith('内置');

function sameCalibration(a: ColorComp, b: ColorComp): boolean {
  const key = (c: ColorComp) => JSON.stringify([c.matrix, c.offset, c.curve]);
  return key(a) === key(b);
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
    const saved: Partial<Record<ProfileKey, Partial<ColorComp>>> = parsed.params?.profiles ?? {};
    const profiles = defaultProfiles();
    for (const k of PROFILE_KEYS) {
      profiles[k] = reviveComp(k, saved[k]);
    }
    params.profiles = profiles;
    params.target = TARGETS.some((t) => t.id === parsed.params?.target)
      ? (parsed.params!.target as TargetId)
      : 'keynote';
    params.color = profiles[profileKey(params.target, params.modelType)];
    // 材质回来了（第二次）。老存档里 material 是 'paper1' / 'metal3' 这类旧 id，
    // 认不得的一律落回「纸张」—— 它就是校准条件，别让一个旧 id 把颜色带偏。
    if (!MATERIALS.some((m) => m.id === params.material)) params.material = DEFAULT_MATERIAL;
    // 预览布光的调杆已经撤了，值写死在 viewer 里；老存档里的 previewTune 直接丢掉
    delete (params as Record<string, unknown>).previewTune;
    const transforms = Array.from({ length: MAX_SLOTS }, (_, i) => ({
      ...DEFAULT_TRANSFORM,
      ...(parsed.transforms?.[i] ?? {}),
    }));
    return { params, transforms };
  } catch {
    return null;
  }
}
