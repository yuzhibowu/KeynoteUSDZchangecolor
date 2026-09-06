import { ColorPanel } from './ColorPanel';
import { Slider } from './Slider';
import { canvasSizeFor } from '../lib/faceTexture';
import type { FaceTextureStore } from '../lib/faceTexture';
import {
  ASPECTS,
  faceChord,
  fromPx,
  radiusFor,
  MAX_SIDES,
  MIN_SIDES,
  RESOLUTIONS,
  toPx,
  type CapMode,
  type FaceState,
  type Params,
  type Resolution,
} from '../lib/types';
import type { ColorComp } from '../lib/color';

type Props = {
  params: Params;
  patch: (p: Partial<Params>) => void;
  selected: number | null;
  face: FaceState | null;
  patchFace: (t: Partial<FaceState>) => void;
  patchColor: (c: Partial<ColorComp>) => void;
  store: FaceTextureStore;
  tick: number;
  onExportChart: () => void;
  onResetFace: () => void;
  onClearFace: () => void;
  onTestFill: () => void;
  onExport: () => void;
  sizeText: string;
  busy: string | null;
};

export function ControlPanel({
  params,
  patch,
  selected,
  face,
  patchFace,
  patchColor,
  store,
  tick,
  onExportChart,
  onResetFace,
  onClearFace,
  onTestFill,
  onExport,
  sizeText,
  busy,
}: Props) {
  const chord = faceChord(params.radius, params.sides);
  const aspect = params.length / chord;
  const canvas = canvasSizeFor(aspect, params.resolution);

  /** 宽度、比例、边数任何一个变了，都要重算半径来保住选定的比例 */
  const patchGeom = (p: Partial<Params>) => {
    const next = { ...params, ...p };
    patch({ ...p, radius: radiusFor(next.length, next.aspect, next.sides) });
  };
  const hasImage = !!face?.source;

  return (
    <aside className="side">
      <div className="side-head">
        <span className="brand">饼饼SHOW</span>
      </div>

      <div className="side-body">
        <section>
          <h2>贴图位置</h2>
          <div className="stack">
            {face && hasImage ? (
              <>
                <div className="filename" title={face.sourceName ?? ''}>
                  {face.sourceName}
                </div>
                <Slider
                  label="缩放"
                  value={face.scale}
                  min={1}
                  max={8}
                  step={0.01}
                  digits={2}
                  suffix="×"
                  onChange={(v) => patchFace({ scale: v })}
                />
                <Slider
                  label="旋转"
                  value={(face.rotation * 180) / Math.PI}
                  min={-180}
                  max={180}
                  step={1}
                  suffix="°"
                  onChange={(v) => patchFace({ rotation: (v * Math.PI) / 180 })}
                />
                <div className="derived">
                  <div>
                    <span>偏移</span>
                    <b>
                      {face.offsetX.toFixed(3)} , {face.offsetY.toFixed(3)}
                    </b>
                  </div>
                </div>
              </>
            ) : (
              <p className="hint">
                点下面那排缩略图右下角的 <b>+</b> 导入图片，或者直接把图片从访达拖到某一格上。
              </p>
            )}
            <div className="row">
              <button className="btn" onClick={onResetFace} disabled={!hasImage}>
                重置此面
              </button>
              <button className="btn" onClick={onClearFace} disabled={!hasImage}>
                移除图片
              </button>
            </div>
            <button
              className="btn"
              onClick={onTestFill}
              title="给每个面填一张带编号的纯色图，用来验证 Keynote 对「多 mesh 多材质」的支持"
            >
              填充测试色块
            </button>
          </div>
        </section>

        <section>
          <h2>几何</h2>
          <div className="stack">
            <Slider
              label="边数"
              value={params.sides}
              min={MIN_SIDES}
              max={MAX_SIDES}
              onChange={(v) => patchGeom({ sides: v })}
            />
            <Slider
              label="宽度"
              value={toPx(params.length)}
              min={100}
              max={10000}
              step={10}
              suffix=" px"
              onChange={(v) => patchGeom({ length: fromPx(v) })}
            />
            <div>
              <span className="slider-head">
                <span>画面比例</span>
              </span>
              <div className="opts four">
                {ASPECTS.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="opt"
                    aria-pressed={Math.abs(params.aspect - a.ratio) < 1e-4}
                    onClick={() => patchGeom({ aspect: a.ratio })}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="derived">
              <div>
                <span>侧面尺寸</span>
                <b>
                  {(params.length * 100).toFixed(2)} × {(chord * 100).toFixed(2)} cm
                </b>
              </div>
              <div>
                <span>粗细（外接圆半径）</span>
                <b>{toPx(params.radius)} px</b>
              </div>
              <div>
                <span>贴图画布</span>
                <b>
                  {canvas.w} × {canvas.h}
                </b>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2>端面</h2>
          <div className="stack">
            <div className="opts">
              {([['solid', '实心'], ['none', '没有端面']] as [CapMode, string][]).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className="opt"
                  aria-pressed={params.capMode === m}
                  onClick={() => patch({ capMode: m })}
                >
                  {label}
                </button>
              ))}
            </div>
            {params.capMode === 'solid' && (
            <div className="color-row">
              <input
                type="color"
                aria-label="两端颜色"
                value={params.capColorRight}
                onChange={(e) => patch({ capColorRight: e.target.value })}
              />
              <span>{params.separateCaps ? '右端' : '两端'}</span>
              {params.separateCaps && (
                <>
                  <input
                    type="color"
                    aria-label="左端颜色"
                    value={params.capColorLeft}
                    onChange={(e) => patch({ capColorLeft: e.target.value })}
                  />
                  <span>左端</span>
                </>
              )}
            </div>
            )}
            {params.capMode === 'solid' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={params.separateCaps}
                  onChange={(e) => patch({ separateCaps: e.target.checked })}
                />
                <span>两端分别设置</span>
              </label>
            )}
            {params.capMode === 'none' && (
              <p className="hint tight">两头不封口，做成一根通透的管子。</p>
            )}
          </div>
        </section>

        <section>
          <h2>贴图</h2>
          <div className="stack">
            <div>
              <span className="slider-head">
                <span>分辨率（长边）</span>
              </span>
              {/* 默认项 1080P 排在第一位 */}
              <div className="opts four">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    className="opt"
                    aria-pressed={params.resolution === r.value}
                    onClick={() => patch({ resolution: r.value as Resolution })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="opts">
              <button
                type="button"
                className="opt"
                aria-pressed={!params.bgTransparent}
                onClick={() => patch({ bgTransparent: false })}
              >
                留白底色
              </button>
              <button
                type="button"
                className="opt"
                aria-pressed={params.bgTransparent}
                onClick={() => patch({ bgTransparent: true })}
              >
                透明
              </button>
            </div>
            {params.bgTransparent ? (
              <p className="hint tight">
                Keynote 对带透明的贴图渲染行为不太稳定，导出后最好自己核一眼。
              </p>
            ) : (
              <div className="color-row">
                <input
                  type="color"
                  aria-label="留白底色"
                  value={params.bgColor}
                  onChange={(e) => patch({ bgColor: e.target.value })}
                />
                <span>图片没盖住的地方填这个色</span>
              </div>
            )}
          </div>
        </section>

        <ColorPanel
          comp={params.color}
          patch={patchColor}
          store={store}
          selected={selected}
          hasImage={hasImage}
          tick={tick}
          onExportChart={onExportChart}
          unlit={params.emissiveExport}
          setUnlit={(v) => patch({ emissiveExport: v })}
          lift={params.emissiveLift ?? 0}
          setLift={(v) => patch({ emissiveLift: v })}
        />

        <section className="export-block">
          <h2>导出</h2>
          <div className="export-meta">
            <span>预估大小</span>
            <b>{sizeText}</b>
          </div>
          <button className="btn-primary" onClick={onExport} disabled={busy !== null}>
            {busy ?? '导出 USDZ'}
          </button>
        </section>
      </div>
    </aside>
  );
}
