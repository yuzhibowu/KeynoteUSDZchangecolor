import { useRef, useState } from 'react';
import { recolorUsdz, type RecolorReport } from '../lib/recolor';
import { download, formatBytes } from '../lib/exportUsdz';
import type { ColorComp } from '../lib/color';

/**
 * 颜色校正模式：把别处做好的 usdz 拖进来，套上同一套偏色抵消，再导出一份新的。
 *
 * 走的是和生成模型完全一样的补偿链路，只是对象换成了现成的文件。
 */
export function RecolorPane({ comp, targetName }: { comp: ColorComp; targetName: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<(RecolorReport & { name: string; size: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const run = async (file: File) => {
    setError(null);
    setReport(null);
    setBusy('正在校正…');
    try {
      const { bytes, report: r } = await recolorUsdz(await file.arrayBuffer(), comp);
      const name = file.name.replace(/\.usdz$/i, '') + `-${targetName}校正.usdz`;
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'model/vnd.usdz+zip' });
      download(blob, name);
      setReport({ ...r, name, size: blob.size });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="recolor"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
      onDrop={(e) => {
        e.currentTarget.classList.remove('drag-over');
        const f = [...e.dataTransfer.files].find((x) => /\.usdz$/i.test(x.name));
        if (!f) return;
        e.preventDefault();
        void run(f);
      }}
    >
      <div className="recolor-box">
        <h2>把现成的 USDZ 拖进来</h2>
        <p className="hint">
          给它套上和生成模型时同一套「{targetName} 偏色抵消」，导出一份新的 USDZ。
          原文件不会被改动。
        </p>
        <button className="btn-primary" disabled={busy !== null} onClick={() => input.current?.click()}>
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
            if (f) void run(f);
          }}
        />

        {error && <p className="hint warn">{error}</p>}

        {report && (
          <div className="recolor-report">
            <p className="hint">
              已导出 <b>{report.name}</b> · {formatBytes(report.size)} —— 在「下载」文件夹里。
            </p>
            <div className="derived">
              <div>
                <span>补偿的贴图</span>
                <b>{report.textures} 张</b>
              </div>
              <div>
                <span>补偿的纯色</span>
                <b>{report.colors} 处</b>
              </div>
              <div>
                <span>补上的自发光</span>
                <b>{report.emissive} 处</b>
              </div>
            </div>
            {report.binary.length > 0 && (
              <p className="hint warn tight">
                这个文件里的场景是二进制的（{report.binary.join('、')}）。贴图已经补偿了，
                但写死在材质里的纯色和自发光动不了 —— 那部分要有 USD 的二进制解析器才能改。
                如果模型的颜色主要来自贴图，影响不大。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
