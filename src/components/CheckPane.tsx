import type { CheckReport, Severity } from '../lib/check';
import type { SlimReport } from '../lib/slim';
import { formatBytes } from '../lib/exportUsdz';

/**
 * 体检模式的左侧：报告。
 * 三档：坏（Keynote 里会显示不出来 / 显示错）、警（会有明显问题）、提示（知道就行）。
 * 能修的标出来，导出之后在最下面列出实际修了什么、贴图瘦了多少。
 */

const SEVERITY: Record<Severity, { label: string; cls: string }> = {
  bad: { label: '会出错', cls: 'bad' },
  warn: { label: '有问题', cls: 'warn' },
  info: { label: '提示', cls: 'info' },
};

export function CheckPane({
  fileName,
  busy,
  error,
  report,
  slimmed,
  onFile,
}: {
  fileName: string | null;
  busy: string | null;
  error: string | null;
  report: CheckReport | null;
  slimmed: SlimReport | null;
  onFile: (f: File) => void;
}) {
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
        onFile(f);
      }}
    >
      {!fileName && !busy && !error && (
        <div className="recolor-empty">
          <h2>把 USDZ 拖进来体检</h2>
          <p className="hint">或者用右边的「选择 USDZ 文件」。只看不改，导出才会生成新文件。</p>
        </div>
      )}
      {busy && !report && <div className="recolor-empty"><h2>{busy}</h2></div>}
      {error && <div className="recolor-empty"><p className="hint warn">{error}</p></div>}

      {report && (
        <div className="check-body">
          <div className="check-summary">
            <div><span>整包</span><b>{formatBytes(report.totalBytes)}</b></div>
            <div><span>贴图</span><b>{formatBytes(report.textureBytes)} · {report.textures.length} 张</b></div>
            <div><span>图层</span><b>{report.layers.length} 个{report.meta.rootBinary ? '，根是二进制' : ''}</b></div>
            <div><span>单位</span><b>{report.meta.metersPerUnit} 米 · {report.meta.upAxis}-up</b></div>
            <div><span>动画</span><b>{report.animation.xformOps + report.animation.skeletal > 0 ? `${report.animation.xformOps} 段变换${report.animation.skeletal ? ` · ${report.animation.skeletal} 骨骼` : ''}` : '无'}</b></div>
          </div>

          <ul className="findings">
            {report.findings.map((f) => (
              <li key={f.id} className={`finding ${SEVERITY[f.severity].cls}`}>
                <div className="finding-head">
                  <span className="finding-tag">{SEVERITY[f.severity].label}</span>
                  <span className="finding-title">{f.title}</span>
                  {f.fixable && <span className="finding-fix">导出时修</span>}
                </div>
                <p className="hint">{f.detail}</p>
              </li>
            ))}
          </ul>

          {report.textures.length > 0 && (
            <div className="tex-table-wrap">
              <table className="tex-table">
                <thead>
                  <tr><th>贴图</th><th>尺寸</th><th>格式</th><th>用途</th><th>体积</th></tr>
                </thead>
                <tbody>
                  {report.textures.map((t) => (
                    <tr key={t.name} className={t.unreferenced ? 'dim' : undefined}>
                      <td title={t.name}>{t.name.split('/').pop()}</td>
                      <td>{t.width && t.height ? `${t.width}×${t.height}` : '?'}</td>
                      <td>{t.format === 'png' ? (t.alphaChannel ? 'PNG α' : 'PNG') : t.format === 'jpeg' ? 'JPEG' : '?'}</td>
                      <td>{t.unreferenced ? '没被引用' : t.roles.length ? t.roles.join(' / ') : '—'}{t.binaryRef ? ' ·二进制' : ''}</td>
                      <td>{formatBytes(t.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {slimmed && (
            <div className="slim-result">
              <h3>
                导出结果：{formatBytes(slimmed.bytesBefore)} → <b>{formatBytes(slimmed.bytesAfter)}</b>
                {slimmed.bytesBefore > 0 && `（${Math.round((1 - slimmed.bytesAfter / slimmed.bytesBefore) * 100)}% 更小）`}
              </h3>
              {Object.keys(slimmed.fixes).length > 0 && (
                <p className="hint">
                  修了：{Object.entries(slimmed.fixes).map(([k, v]) => `${FIX_LABEL[k] ?? k} × ${v}`).join('、')}
                </p>
              )}
              <div className="tex-table-wrap">
                <table className="tex-table">
                  <thead>
                    <tr><th>贴图</th><th>之前</th><th>之后</th><th>做了什么</th></tr>
                  </thead>
                  <tbody>
                    {slimmed.textures.map((t) => (
                      <tr key={t.name}>
                        <td title={t.newName}>{t.newName.split('/').pop()}</td>
                        <td>{formatBytes(t.before)}</td>
                        <td>{formatBytes(t.after)}</td>
                        <td>{t.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FIX_LABEL: Record<string, string> = {
  'xformop-suffix': '去掉 xformOp 后缀',
  extent: '补包围盒',
  'default-prim': '补 defaultPrim',
  'rotate-xyz-anim': '旋转动画改四元数',
  'zip-compressed': '解开压缩存储',
  'zip-align': '64 字节对齐',
  root: '根图层挪到第一位',
};
