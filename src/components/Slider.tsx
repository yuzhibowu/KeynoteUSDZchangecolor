/**
 * 全站统一的滑块。
 *
 * 轨道左右两段都是 6px、无描边无阴影；圆钮 16px 实心。关键是**填充终点要落在圆钮中心**，
 * 而不是按整个输入框宽度算百分比 —— 圆钮半径 8px，它的中心只在左右各内缩 8px 的范围里移动。
 * 所以分界位置是 `p × 100% + (8 − 16p)px`，负值范围（角度、位置）同样适用。
 *
 * 圆钮尺寸如果要改，这里的 8 / 16 和 CSS 里的 margin-top 必须一起改。
 */
type Snap = { value: number; label: string };

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  digits?: number;
  suffix?: string;
  disabled?: boolean;
  /** 数值旁边额外显示的说明，比如吸附到的比例名 */
  note?: string;
  /** 吸附点：拖到附近会被吸过去，轨道上也会标出来 */
  snaps?: Snap[];
  onChange: (v: number) => void;
};

const THUMB = 16;
/** 吸附半径：占整条轨道的比例。太大会粘手，太小又吸不住 */
const SNAP_RATIO = 0.022;

/** 圆钮中心在轨道上的位置，两端各内缩 8px */
const at = (p: number) => `calc(${(p * 100).toFixed(4)}% + ${(THUMB / 2 - THUMB * p).toFixed(4)}px)`;

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  digits = 0,
  suffix = '',
  disabled,
  note,
  snaps,
  onChange,
}: Props) {
  const span = max - min;
  const p = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0;

  const handle = (raw: number) => {
    if (!snaps || snaps.length === 0) return onChange(raw);
    const tol = span * SNAP_RATIO;
    let best: Snap | null = null;
    let bestD = Infinity;
    for (const s of snaps) {
      const d = Math.abs(s.value - raw);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return onChange(raw);
    // 刚吸上去的那一下给一点触感反馈（支持的设备上才有；macOS 触控板不开放这个接口）
    if (Math.abs(best.value - value) > 0.001 && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }
    onChange(best.value);
  };

  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <b>
          {value.toFixed(digits)}
          {suffix}
          {note ? ` · ${note}` : ''}
        </b>
      </span>
      <span className="slider-track">
        {snaps && snaps.length > 0 && (
          <span className="snap-marks" aria-hidden="true">
            {snaps.map((s) => (
              <i
                key={s.label}
                className={Math.abs(s.value - value) < 0.001 ? 'on' : ''}
                style={{ left: at(Math.min(1, Math.max(0, (s.value - min) / span))) }}
                data-label={s.label}
              />
            ))}
          </span>
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          style={{ '--split': at(p) } as React.CSSProperties}
          onChange={(e) => handle(Number(e.target.value))}
        />
      </span>
    </label>
  );
}
