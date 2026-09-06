import type { RecolorReport } from '../lib/recolor';

/**
 * 颜色校正模式的左侧区域：校正前 / 校正后的对照。
 *
 * 文件按钮和导出按钮都在右侧栏 —— 这里只负责「让你看清它把颜色改成了什么样」。
 */
export function RecolorPane({
  fileName,
  busy,
  error,
  report,
  targetName,
  onFile,
}: {
  fileName: string | null;
  targetName: string;
  busy: string | null;
  error: string | null;
  report: RecolorReport | null;
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
      {!fileName && !busy && (
        <div className="recolor-empty">
          <h2>把现成的 USDZ 拖进来</h2>
          <p className="hint">或者用右边的「选择 USDZ 文件」。原文件不会被改动。</p>
        </div>
      )}

      {busy && <div className="recolor-empty"><h2>{busy}</h2></div>}
      {error && <div className="recolor-empty"><p className="hint warn">{error}</p></div>}

      {report && !busy && (
        <div className="recolor-body">
          {/* 比的是「放进去之后长什么样」，不是文件本身的样子 —— 文件里那张
              补偿过的图又暗又怪，本来就不是给人看的 */}
          {report.previews.map((p) => (
            <div className="compare" key={p.name}>
              <span className="compare-name">{p.name}</span>
              <div className="compare-pair three">
                <figure>
                  <img src={p.source} alt="" />
                  <figcaption>你的原图</figcaption>
                </figure>
                <figure>
                  <img src={p.before} alt="" />
                  <figcaption>不校正，进{targetName}会变成这样</figcaption>
                </figure>
                <figure>
                  <img src={p.after} alt="" />
                  <figcaption>校正后，进{targetName}是这样</figcaption>
                </figure>
              </div>
            </div>
          ))}

          {report.swatches.length > 0 && (
            <div className="compare">
              <span className="compare-name">材质里写死的纯色（上：校正前 / 下：校正后）</span>
              <div className="swatch-row">
                {report.swatches.map((s) => (
                  <div className="swatch" key={s.before} title={`${s.before} → ${s.after}`}>
                    <i style={{ background: s.before }} />
                    <i style={{ background: s.after }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="hint">
            这三张比的是「放进{targetName}之后长什么样」，不是文件本身的样子。
            中间那张就是你现在遇到的偏色；右边那张应该和左边的原图基本一致 ——
            那就是校正做到的事。（新文件里的贴图本身看着会更暗更闷，
            那是算好了要被{targetName}提亮一道的半成品，不用管它。）
          </p>

          {report.binary.length > 0 && (
            <p className="hint warn">
              这个文件的场景是二进制的（{report.binary.join('、')}）。贴图已经补偿了，
              但写死在材质里的纯色和自发光动不了 —— 那需要 USD 的二进制解析器。
              如果模型的颜色主要来自贴图，影响不大。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
