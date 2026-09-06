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
  onChange,
}: Props) {
  const p = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
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
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
