import { ColorPanel } from './ColorPanel';
import { Slider } from './Slider';
import type { FaceTextureStore } from '../lib/faceTexture';
import {
  ASPECTS,
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
  onExport,
  sizeText,
  busy,
}: Props) {
  // Safari 没有 showSaveFilePicker，导出只能落到「下载」文件夹 —— 先说清楚，免得用户找不到文件
  const canPickFolder = typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

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
        {/* 没选中带图的面就整段不显示 —— 重置/移除/填充测试色块那三个按钮
            已经挪到预览区右下角，这里只留跟「这张图怎么摆」有关的东西 */}
        {face && hasImage && (
          <section>
            <h2>贴图位置</h2>
            <div className="stack">
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
            </div>
          </section>
        )}

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
          {!canPickFolder && (
            <p className="hint tight">
              这个浏览器不支持选择保存位置，文件会直接存进「下载」文件夹。想自己选位置就用 Chrome。
            </p>
          )}
          <button className="btn-primary" onClick={onExport} disabled={busy !== null}>
            {busy ?? '导出 USDZ'}
          </button>
        </section>
      </div>
    </aside>
  );
}
