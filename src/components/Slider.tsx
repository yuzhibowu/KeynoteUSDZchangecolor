/**
 * 全站统一的滑块。
 *
 * 轨道左右两段都是 6px、无描边无阴影；圆钮 16px 实心。关键是**填充终点要落在圆钮中心**，
 * 而不是按整个输入框宽度算百分比 —— 圆钮半径 8px，它的中心只在左右各内缩 8px 的范围里移动。
 * 所以分界位置是 `p × 100% + (8 − 16p)px`，负值范围（角度、位置）同样适用。
 *
 * 圆钮尺寸如果要改，这里的 8 / 16 和 CSS 里的 margin-top 必须一起改。
 */
type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  digits?: number;
  suffix?: string;
  disabled?: boolean;
  /** 数值旁边额外显示的说明 */
  note?: string;
  /** 给了就把标签变成按钮：点一下回到这个默认值 */
  reset?: number;
  /** 吸附点：拖到附近会咬住这些值 */
  snaps?: number[];
  /** 吸附范围（值的单位），默认是全程的 1.5% */
  snapRange?: number;
  onChange: (v: number) => void;
};

const THUMB = 16;

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
  reset,
  snaps,
  snapRange,
  onChange,
}: Props) {
  const p = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  // 靠近吸附点就咬住它。没有触觉反馈这回事 —— 网页拿不到触控板的震动，
  // 能做的只有「拖过去会顿一下」这个手感。
  const snapped = (v: number) => {
    if (!snaps || snaps.length === 0) return v;
    const range = snapRange ?? (max - min) * 0.015;
    let best = v;
    let bestD = range;
    for (const s of snaps) {
      const d = Math.abs(v - s);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };
  const split = `calc(${(p * 100).toFixed(4)}% + ${(THUMB / 2 - THUMB * p).toFixed(4)}px)`;
  return (
    <label className="slider">
      <span className="slider-head">
        {/* 点标签 = 回到默认值。是个 button 而不是 span，键盘也能用 */}
        {reset === undefined ? (
          <span>{label}</span>
        ) : (
          <button
            type="button"
            className="slider-reset"
            title={`点一下回到默认值 ${reset}`}
            disabled={disabled}
            onClick={() => onChange(reset)}
          >
            {label}
          </button>
        )}
        <b>
          {value.toFixed(digits)}
          {suffix}
          {note ? ` · ${note}` : ''}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        style={{ '--split': split } as React.CSSProperties}
        onChange={(e) => onChange(snapped(Number(e.target.value)))}
      />
    </label>
  );
}
