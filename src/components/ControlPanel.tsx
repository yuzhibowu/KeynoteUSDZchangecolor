import type { FaceState, Params, Resolution } from '../lib/types';
import { faceChord, MAX_SIDES, MIN_SIDES } from '../lib/types';
import { canvasSizeFor, type FaceTextureStore } from '../lib/faceTexture';
import { ColorPanel } from './ColorPanel';
import type { ColorComp } from '../lib/color';

type Props = {
  params: Params;
  patch: (p: Partial<Params>) => void;
  selected: number | null;
  face: FaceState | null;
  patchFace: (t: Partial<FaceState>) => void;
  onResetRotation: () => void;
  onFaceOn: () => void;
  patchColor: (c: Partial<ColorComp>) => void;
  store: FaceTextureStore;
  tick: number;
  onExportChart: () => void;
};

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  digits?: number;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step, suffix = '', digits = 0, onChange } = props;
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <b>
          {value.toFixed(digits)}
          {suffix}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function ControlPanel({
  params,
  patch,
  selected,
  face,
  patchFace,
  onResetRotation,
  onFaceOn,
  patchColor,
  store,
  tick,
  onExportChart,
}: Props) {
  const chord = faceChord(params.radius, params.sides);
  const aspect = params.length / chord;
  const canvas = canvasSizeFor(aspect, params.resolution);

  return (
    <aside className="panel">
      <h1>棱柱 USDZ 导出器</h1>

      <section>
        <h2>几何</h2>
        <Slider
          label="边数"
          value={params.sides}
          min={MIN_SIDES}
          max={MAX_SIDES}
          step={1}
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
        <div className="row">
          <button className="ghost grow" onClick={onFaceOn} disabled={selected === null}>
            正对当前面
          </button>
          <button className="ghost grow" onClick={onResetRotation}>
            重置角度
          </button>
        </div>
      </section>

      <section>
        <h2>端面（左右两端）</h2>
        <div className="row">
          <label className="color">
            <input
              type="color"
              value={params.capColorRight}
              onChange={(e) => patch({ capColorRight: e.target.value })}
            />
            <span>{params.separateCaps ? '右端' : '两端'}</span>
          </label>
          {params.separateCaps && (
            <label className="color">
              <input
                type="color"
                value={params.capColorLeft}
                onChange={(e) => patch({ capColorLeft: e.target.value })}
              />
              <span>左端</span>
            </label>
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
      </section>

      <section>
        <h2>贴图</h2>
        <label className="field">
          <span>分辨率（长边）</span>
          <select
            value={params.resolution}
            onChange={(e) => patch({ resolution: Number(e.target.value) as Resolution })}
          >
            <option value={512}>512</option>
            <option value={1024}>1024</option>
            <option value={2048}>2048</option>
          </select>
        </label>
        <label className="color wide">
          <input type="color" value={params.bgColor} onChange={(e) => patch({ bgColor: e.target.value })} />
          <span>留白底色（不留透明）</span>
        </label>
      </section>

      <ColorPanel
        comp={params.color}
        patch={patchColor}
        store={store}
        selected={selected}
        hasImage={!!face?.source}
        tick={tick}
        onExportChart={onExportChart}
        unlit={params.emissiveExport}
        setUnlit={(v) => patch({ emissiveExport: v })}
        lift={params.emissiveLift ?? 0}
        setLift={(v) => patch({ emissiveLift: v })}
      />

      <section>
        <h2>当前面 {selected === null ? '—' : `face ${selected}`}</h2>
        {face && face.source ? (
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
            <div className="derived small">
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
            选中一个面再上传图片。空白处拖动 = 转物体；有图的选中面上拖动 = 挪贴图，滚轮缩放。
          </p>
        )}
      </section>
    </aside>
  );
}
