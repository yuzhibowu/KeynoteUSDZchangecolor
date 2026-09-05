import { useRef } from 'react';
import { ColorPanel } from './ColorPanel';
import { FaceStrip } from './FaceStrip';
import { Slider } from './Slider';
import { canvasSizeFor } from '../lib/faceTexture';
import type { FaceTextureStore } from '../lib/faceTexture';
import { faceChord, MAX_SIDES, MIN_SIDES, type FaceState, type Params, type Resolution } from '../lib/types';
import type { ColorComp } from '../lib/color';

type Props = {
  params: Params;
  patch: (p: Partial<Params>) => void;
  selected: number | null;
  face: FaceState | null;
  faces: FaceState[];
  patchFace: (t: Partial<FaceState>) => void;
  onSelect: (i: number) => void;
  patchColor: (c: Partial<ColorComp>) => void;
  store: FaceTextureStore;
  tick: number;
  onExportChart: () => void;
  onFiles: (files: File[], faceIndex?: number) => void;
  onResetFace: () => void;
  onClearFace: () => void;
  onTestFill: () => void;
  onExport: () => void;
  sizeText: string;
  busy: string | null;
};

/** 通栏深色按钮，可以点也可以把文件拖上去 */
function ImportButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <button
      className="btn-primary"
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        e.currentTarget.classList.add('drag-over');
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
      onDrop={(e) => {
        e.currentTarget.classList.remove('drag-over');
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return;
        e.preventDefault();
        onFiles(files);
      }}
    >
      导入图片
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </button>
  );
}

export function ControlPanel({
  params,
  patch,
  selected,
  face,
  faces,
  patchFace,
  onSelect,
  patchColor,
  store,
  tick,
  onExportChart,
  onFiles,
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
  const withImage = faces.slice(0, params.sides).filter((f) => f.source).length;
  const hasImage = !!face?.source;

  return (
    <aside className="side">
      <div className="side-head">
        <ImportButton onFiles={(f) => onFiles(f, f.length > 1 ? 0 : (selected ?? 0))} />
        <div className="asset-status">
          {withImage === 0
            ? '还没有贴图 · 单张贴到选中面，多张按文件名依次分配'
            : `已贴 ${withImage} / ${params.sides} 个面`}
        </div>
      </div>

      <div className="side-body">
        <section>
          <h2>面</h2>
          <div className="stack">
            <FaceStrip
              store={store}
              faces={faces}
              sides={params.sides}
              selected={selected}
              tick={tick}
              onSelect={onSelect}
              onDropFiles={(files, i) => onFiles(files, i)}
            />
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
                选中一个面再导入图片。空白处拖动 = 转物体；有图的选中面上拖动 = 挪贴图，滚轮缩放。
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
              onChange={(v) => patch({ sides: v })}
            />
            <Slider
              label="粗细（外接圆半径）"
              value={params.radius * 100}
              min={1}
              max={50}
              step={0.5}
              suffix=" cm"
              digits={1}
              onChange={(v) => patch({ radius: v / 100 })}
            />
            <Slider
              label="长度（左右方向）"
              value={params.length * 100}
              min={1}
              max={100}
              step={0.5}
              suffix=" cm"
              digits={1}
              onChange={(v) => patch({ length: v / 100 })}
            />
            <div className="derived">
              <div>
                <span>侧面尺寸</span>
                <b>
                  {(params.length * 100).toFixed(2)} × {(chord * 100).toFixed(2)} cm
                </b>
              </div>
              <div className="hero">
                <span>侧面宽高比</span>
                <b>{aspect >= 1 ? `${aspect.toFixed(2)} : 1` : `1 : ${(1 / aspect).toFixed(2)}`}</b>
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
          <h2>端面（左右两端）</h2>
          <div className="stack">
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
            <label className="check">
              <input
                type="checkbox"
                checked={params.separateCaps}
                onChange={(e) => patch({ separateCaps: e.target.checked })}
              />
              <span>两端分别设置</span>
            </label>
          </div>
        </section>

        <section>
          <h2>贴图</h2>
          <div className="stack">
            <div>
              <span className="slider-head">
                <span>分辨率（长边）</span>
              </span>
              {/* 默认项 1024 排在第一位 */}
              <div className="opts">
                {([1024, 512, 2048] as Resolution[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="opt"
                    aria-pressed={params.resolution === r}
                    onClick={() => patch({ resolution: r })}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="color-row">
              <input
                type="color"
                aria-label="留白底色"
                value={params.bgColor}
                onChange={(e) => patch({ bgColor: e.target.value })}
              />
              <span>留白底色（不留透明）</span>
            </div>
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
