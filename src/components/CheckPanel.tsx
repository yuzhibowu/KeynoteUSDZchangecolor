import { useRef } from 'react';
import { Slider } from './Slider';
import type { CheckReport } from '../lib/check';
import type { SlimOptions } from '../lib/slim';

export type CheckSidebar = {
  fileName: string | null;
  report: CheckReport | null;
  busy: string | null;
  slim: SlimOptions;
  patchSlim: (p: Partial<SlimOptions>) => void;
  onPick: (f: File) => void;
  onExport: () => void;
};

const MAX_SIZES = [
  { value: 1024, label: '1024' },
  { value: 2048, label: '2048' },
  { value: 4096, label: '4096' },
  { value: 0, label: '不限' },
];

/**
 * 体检模式的侧栏：选文件、瘦身的三个参数、导出。
 * 报告本身在左边显示 —— 这里只放要动手的东西。
 */
export function CheckPanel({ fileName, report, busy, slim, patchSlim, onPick, onExport }: CheckSidebar) {
  const input = useRef<HTMLInputElement>(null);
  const fixable = report?.findings.filter((f) => f.fixable && !['texture-huge', 'texture-opaque-png'].includes(f.id)).length ?? 0;
  const bigTex = report ? report.textures.filter((t) => slim.maxSize > 0 && Math.max(t.width ?? 0, t.height ?? 0) > slim.maxSize).length : 0;
  const pngTex = report ? report.textures.filter((t) => t.format === 'png' && !t.roles.includes('normal') && !t.roles.includes('opacity') && !t.binaryRef).length : 0;
  return (
    <>
      <section className="bare">
        <div className="stack">
          <button className="btn" disabled={busy !== null} onClick={() => input.current?.click()}>
            {busy ?? '选择 USDZ 文件'}
          </button>
          <input
            ref={input}
            type="file"
            accept=".usdz,model/vnd.usdz+zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onPick(f);
            }}
          />
          {fileName && <div className="filename" title={fileName}>{fileName}</div>}
          <p className="hint">拖进来看一眼，点导出就修好、瘦好。原文件不动。</p>
        </div>
      </section>

      <section>
        <h2>瘦身</h2>
        <div className="stack">
          <div className="opts four">
            {MAX_SIZES.map((m) => (
              <button
                key={m.value}
                type="button"
                className="opt"
                aria-pressed={slim.maxSize === m.value}
                onClick={() => patchSlim({ maxSize: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={slim.jpegOpaque} onChange={(e) => patchSlim({ jpegOpaque: e.target.checked })} />
            <span>不透明的 PNG 转成 JPEG</span>
          </label>
          <Slider
            label="JPEG 质量"
            value={slim.quality}
            min={0.6}
            max={1}
            step={0.01}
            digits={2}
            reset={0.92}
            disabled={!slim.jpegOpaque}
            onChange={(v) => patchSlim({ quality: v })}
          />
          <p className="hint">
            贴图最长边超过上面的上限就缩小，2048 够用。只转真不透明的 PNG，法线和透明贴图不动；
            颜色校正过的卡片别转，JPEG 会抹掉一两个色阶。
            {report && bigTex + pngTex > 0 && <>{' '}这份里 {bigTex} 张要缩、{pngTex} 张可能转。</>}
          </p>
        </div>
      </section>

      <section className="bare">
        <button className="btn-primary" disabled={!report || busy !== null} onClick={onExport}>
          {busy ?? '修好并瘦身，导出'}
        </button>
        {report && fixable > 0 && <p className="hint">顺手修 {fixable} 项。</p>}
      </section>
    </>
  );
}
