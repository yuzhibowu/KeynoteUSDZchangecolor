/** 从原 chart.ts 原样提取；核心和标定共用，避免带入 DOM 色卡代码。 */
export const CURVE_K = 5;

/** 单调分段线性求逆 */
export function pwInvert(y: number, ys: number[]): number {
  if (y <= ys[0]) return 0;
  if (y >= ys[CURVE_K - 1]) return 1;
  for (let i = 0; i < CURVE_K - 1; i++) {
    if (y <= ys[i + 1]) {
      const d = ys[i + 1] - ys[i];
      return (i + (d > 1e-9 ? (y - ys[i]) / d : 0)) / (CURVE_K - 1);
    }
  }
  return 1;
}
