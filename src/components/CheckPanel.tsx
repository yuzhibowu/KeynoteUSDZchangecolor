import { useRef } from 'react';
import { Slider } from './Slider';
import type { CheckReport } from '../lib/check';
import type { SlimOptions } from '../lib/slim';
import { formatBytes } from '../lib/exportUsdz';

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
          <p className="hint">
            拖一个 USDZ 进来，按这个项目攒下来的 Keynote 实测规律逐条过一遍：哪些会出问题、哪些能顺手修掉。
            原文件不会被改动。
          </p>
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
            上面是贴图最长边的上限：幻灯片上一个模型占不到半屏，2048 够用；超过上限的等比缩小。转 JPEG 只动真的不透明的图：
            用在透明度上的、法线贴图、只被二进制图层引用的都留着 PNG。颜色校正过的卡片别转——JPEG 会把颜色抹掉一两个色阶。
            {report && (
              <>
                {' '}这份文件里 {bigTex} 张要缩、{pngTex} 张 PNG 可能转（要解码看了才知道是不是真不透明）。
              </>
            )}
          </p>
        </div>
      </section>

      <section className="bare">
        <button className="btn-primary" disabled={!report || busy !== null} onClick={onExport}>
          {busy ?? '修好并瘦身，导出'}
        </button>
        {report && (
          <p className="hint">
            会修 {fixable} 项，重新按 usdz 规范打包；贴图 {formatBytes(report.textureBytes)}，整包 {formatBytes(report.totalBytes)}。
            修不了的那些只是告诉你，导出不会碰。
          </p>
        )}
      </section>
    </>
  );
}
