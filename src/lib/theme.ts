/**
 * 亮色 / 暗色 / 跟随系统。
 *
 * 选择记在 localStorage，写在 <html data-theme> 上；不选就什么都不写，
 * CSS 那边由 prefers-color-scheme 接管。三种状态而不是两种 ——
 * 「跟随系统」是大多数人真正想要的默认。
 */
export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'prism-usdz-exporter/theme';

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* 隐私模式，记不住就算了 */
  }
}

/** 当前实际是不是暗的（跟随系统时要问系统） */
export function isDark(t: Theme): boolean {
  if (t !== 'auto') return t === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
