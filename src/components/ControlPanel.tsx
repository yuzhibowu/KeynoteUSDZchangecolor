import { ColorPanel } from './ColorPanel';
import { useRef } from 'react';
import { Slider } from './Slider';
import { FramePreview } from './FramePreview';
import type { FaceTextureStore } from '../lib/faceTexture';
import {
  ASPECTS,
  fromPx,
  radiusFor,
  MODEL_TYPES,
  type ModelType,
  DEFAULT_PARAMS,
  DEFAULT_PREVIEW_TUNE,
  CARD_FRONT,
  type Mode,
  MAX_SIDES,
  MIN_SIDES,
  RESOLUTIONS,
  toPx,
  type CapMode,
  type FaceState,
  type Params,
  type Resolution,
  type TargetId,
} from '../lib/types';
import type { ColorComp } from '../lib/color';
import { MATERIALS } from '../lib/material';

type Props = {
  params: Params;
  patch: (p: Partial<Params>) => void;
  mode: Mode;
  recolorName: string | null;
  recolorReady: boolean;
  recolorBusy: string | null;
  onPickRecolor: (f: File) => void;
  onExportRecolor: () => void;
  spin: boolean;
  onToggleSpin: () => void;
  canSpin: boolean;
  selected: number | null;
  face: FaceState | null;
  patchFace: (t: Partial<FaceState>) => void;
  /** 在取景框里拖动 —— 单位是画布宽/高的几分之几 */
  onPan: (dx: number, dy: number, commit: boolean) => void;
  patchColor: (c: Partial<ColorComp>) => void;
  setTarget: (t: TargetId) => void;
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
  mode,
  recolorName,
  recolorReady,
  recolorBusy,
  onPickRecolor,
  onExportRecolor,
  spin,
  onToggleSpin,
  canSpin,
  selected,
  face,
  patchFace,
  onPan,
  patchColor,
  setTarget,
  store,
  tick,
  onExportChart,
  onExport,
  sizeText,
  busy,
}: Props) {

  /** 宽度、比例、边数任何一个变了，都要重算半径来保住选定的比例 */
  const recolorInput = useRef<HTMLInputElement>(null);
  const isPrism = params.modelType === 'prism';
  // 宽度滑杆上标出来的档位，按数值从小到大排，刻度才不会左右乱跳
  // 标签用短名，不然 720P / 1080P 两个挤在一起会叠字
  const WIDTH_MARKS = [...RESOLUTIONS]
    .sort((a, b) => a.value - b.value)
    .map((r) => ({ value: r.value, label: r.label.replace(/P$/, '') }));
  // 侧边色默认取正面贴图的平均色；tick 变了要重取（贴图换了平均色就变了）
  void tick;
  const edgeColor = params.edgeAuto ? store.averageColor(CARD_FRONT) : params.capColorRight;
  const patchGeom = (p: Partial<Params>) => {
    const next = { ...params, ...p };
    patch({ ...p, radius: radiusFor(next.length, next.aspect, next.sides) });
  };
  /**
   * 在不在自定义模式。
   *
   * 只要有一格填过就算 —— 不能要求两格都有值：用户把「高」删空准备重打的那一瞬间，
   * 整行输入框会直接消失，字还没敲完框就没了。点任何一个预设才会退出自定义。
   */
  const isCustomAspect =
    !params.fitFront && (params.aspectW !== undefined || params.aspectH !== undefined);

  /**
   * 改宽或改高。传 null 表示这一格不动。
   *
   * 中间态要留得住：清空输入框、或者敲到一半只有 "0"，都不能立刻把比例算成
   * 0 或 NaN 塞回去 —— 那会让半径变成 0，模型当场消失，用户还在打字。
   * 所以只有两边都是正数时才真的换 aspect，否则只记住输入框里的字。
   */
  const setRatio = (wRaw: string | null, hRaw: string | null) => {
    const num = (v: string | null, fallback: number | undefined) => {
      if (v === null) return fallback;
      const n = Number(v);
      return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
    };
    const w = num(wRaw, params.aspectW);
    const h = num(hRaw, params.aspectH);
    const usable = w !== undefined && h !== undefined && w > 0 && h > 0;
    patchGeom({ aspectW: w, aspectH: h, aspect: usable ? w / h : params.aspect });
  };

  const hasImage = !!face?.source;

  return (
    <aside className="side">
      <div className="side-head">
        {/* 模型类型（棱柱 / 卡片）还在原来的位置；左上角那个菜单管的是另一件事 */}
        {mode !== 'recolor' && (
          <select
            className="model-type"
            aria-label="模型类型"
            value={params.modelType}
            onChange={(e) => patch({ modelType: e.target.value as ModelType })}
          >
            {MODEL_TYPES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        {/* 暂停旋转放在品牌这一行的左边 */}
        {canSpin && (
          <button className="btn spin-toggle" onClick={onToggleSpin}>
            {spin ? '暂停旋转' : '继续旋转'}
          </button>
        )}
        <span className="brand">饼饼SHOW</span>
      </div>

      <div className="side-body">
        {mode === 'recolor' ? (
          <>
          <section className="bare">
            <div className="stack">
              <button
                className="btn"
                disabled={recolorBusy !== null}
                onClick={() => recolorInput.current?.click()}
              >
                {recolorBusy ?? '选择 USDZ 文件'}
              </button>
              <input
                ref={recolorInput}
                type="file"
                accept=".usdz,model/vnd.usdz+zip"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) onPickRecolor(f);
                }}
              />
              {recolorName && <div className="filename" title={recolorName}>{recolorName}</div>}
            </div>
          </section>
          <ColorPanel
            comp={params.color}
            patch={patchColor}
            target={params.target}
            setTarget={setTarget}
            store={store}
            selected={null}
            hasImage={false}
            tick={tick}
            onExportChart={onExportChart}
            shapeLabel={params.modelType === 'card' ? '卡片' : '棱柱'}
            modelType={params.modelType}
            unlit={params.emissiveExport}
            setUnlit={(v) => patch({ emissiveExport: v })}
            lift={params.emissiveLift ?? 0}
            setLift={(v) => patch({ emissiveLift: v })}
          />
          <section className="export-block">
            <button className="btn-primary" disabled={!recolorReady} onClick={onExportRecolor}>
              导出 USDZ
            </button>
          </section>
          </>
        ) : (
        <>
        {/* 逐面的「不显示」。USD 是单面渲染的，藏掉之后从这一侧看过去是空的、
            能看穿到里面，转过去又出现 —— 不是透明，是那个面真的不存在。
            导出的 usdz 里也一样不会有这个面。 */}
        {face && (
          <section className="bare">
            <label className="check">
              <input
                type="checkbox"
                checked={!!face.hidden}
                onChange={(e) => patchFace({ hidden: e.target.checked })}
              />
              <span>这一面不显示</span>
            </label>
          </section>
        )}

        {/* 没选中带图的面就整段不显示 —— 重置/移除/填充测试色块那三个按钮
            已经挪到预览区右下角，这里只留跟「这张图怎么摆」有关的东西 */}
        {face && hasImage && (
          <section>
            <h2>贴图位置</h2>
            <div className="stack">
                <div className="filename" title={face.sourceName ?? ''}>
                  {face.sourceName}
                </div>
                {/* 挪图只在这里做。视口里拖鼠标一律是转模型，绝不动图 */}
                {selected !== null && (
                  <FramePreview store={store} index={selected} tick={tick} onPan={onPan} />
                )}
                <p className="hint tight">在上面这张图里按住拖动，可以挪动画面。</p>
                <Slider
                  label="缩放"
                  reset={1}
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
                  reset={0}
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

        {/* 不要标题、也不要上面那条分隔线 */}
        <section className="bare">
          <div className="stack">
            {/* 卡片就是正反两面，没有边数可调 */}
            {isPrism && (
              <Slider
                label="边数"
                reset={DEFAULT_PARAMS.sides}
                value={params.sides}
                min={MIN_SIDES}
                max={MAX_SIDES}
                onChange={(v) => patchGeom({ sides: v })}
              />
            )}
            {/* 卡片：厚度、圆角排在宽度前面 —— 都是「这张卡长什么样」，归在一起 */}
            {!isPrism && (
              <>
                <Slider
                  label="厚度"
                  reset={toPx(DEFAULT_PARAMS.thickness)}
                  value={toPx(params.thickness)}
                  min={2}
                  max={600}
                  step={1}
                  suffix=" px"
                  onChange={(v) => patch({ thickness: fromPx(v) })}
                />
                {params.fitFront ? (
                  <p className="hint tight">
                    圆角 {toPx(params.corner)} px —— 「适应」开着，跟着正面图片的圆角走。想手调就把画面比例换成别的预设。
                  </p>
                ) : (
                  <Slider
                    label="圆角"
                    reset={toPx(DEFAULT_PARAMS.corner)}
                    value={toPx(params.corner)}
                    min={0}
                    max={Math.round(toPx(Math.min(params.length, params.length / params.aspect)) / 2)}
                    step={1}
                    suffix=" px"
                    onChange={(v) => patch({ corner: fromPx(v) })}
                  />
                )}
                <div className="color-row">
                  <input
                    type="color"
                    aria-label="侧边颜色"
                    value={edgeColor}
                    onChange={(e) => patch({ capColorRight: e.target.value, edgeAuto: false })}
                  />
                  <span>侧边颜色{params.edgeAuto ? '（跟着正面走）' : ''}</span>
                  {!params.edgeAuto && (
                    <button className="btn" onClick={() => patch({ edgeAuto: true })}>
                      跟随正面
                    </button>
                  )}
                </div>
              </>
            )}
            <Slider
              label="宽度"
              reset={toPx(DEFAULT_PARAMS.length)}
              // 四档分辨率对应的宽度各设一个吸附点，拖到附近会咬住
              snaps={WIDTH_MARKS.map((r) => r.value)}
              snapLabels={WIDTH_MARKS.map((r) => r.label)}
              value={toPx(params.length)}
              min={100}
              // 上限从 10000（1 米）收到 5000：四个分辨率档全在 3840 以内，
              // 量程放到 1 米的话它们会挤在滑杆左边三分之一，刻度叠成一团。
              max={5000}
              step={10}
              suffix=" px"
              onChange={(v) => patchGeom({ length: fromPx(v) })}
            />
            <div>
              <span className="slider-head">
                <span>画面比例</span>
              </span>
              <div className="opts four">
                {/* 卡片：「适应」= 比例和圆角都按正面那张 PNG 的不透明区域来，透明留白自动裁掉 */}
                {!isPrism && (
                  <button
                    type="button"
                    className="opt"
                    aria-pressed={params.fitFront}
                    title="比例和圆角跟着正面图片走，透明留白自动裁掉"
                    onClick={() => patchGeom({ fitFront: true, aspectW: undefined, aspectH: undefined })}
                  >
                    适应
                  </button>
                )}
                {ASPECTS.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="opt"
                    aria-pressed={!params.fitFront && !isCustomAspect && Math.abs(params.aspect - a.ratio) < 1e-4}
                    onClick={() => patchGeom({ fitFront: false, aspect: a.ratio, aspectW: undefined, aspectH: undefined })}
                  >
                    {a.label}
                  </button>
                ))}
                {/* 预设之外的比例。点一下就把当前比例拆成两个数填进输入框，
                    用户接着改哪个都行 —— 不用先猜一组数字再开始调 */}
                <button
                  type="button"
                  className="opt"
                  aria-pressed={!params.fitFront && isCustomAspect}
                  onClick={() => {
                    if (!params.fitFront && isCustomAspect) return;
                    const w = Math.round(params.aspect * 100);
                    patchGeom({ fitFront: false, aspect: params.aspect, aspectW: w, aspectH: 100 });
                  }}
                >
                  自定义
                </button>
              </div>
              {!isPrism && params.fitFront && (
                <p className="hint tight">
                  {face?.source && params.modelType === 'card'
                    ? `按正面图片：${params.aspect.toFixed(3)}（透明留白已裁掉）`
                    : '贴上正面图片后，比例和圆角自动跟着它走'}
                </p>
              )}
              {isCustomAspect && (
                <div className="ratio-row">
                  <input
                    type="number"
                    aria-label="自定义比例：宽"
                    min={1}
                    step={1}
                    value={params.aspectW ?? ''}
                    onChange={(e) => setRatio(e.target.value, null)}
                  />
                  <span>:</span>
                  <input
                    type="number"
                    aria-label="自定义比例：高"
                    min={1}
                    step={1}
                    value={params.aspectH ?? ''}
                    onChange={(e) => setRatio(null, e.target.value)}
                  />
                  <b>{params.aspect.toFixed(3)}</b>
                </div>
              )}
            </div>
          </div>
        </section>

        <section>
          <h2>材质</h2>
          <div className="stack">
            <div className="opts four">
              {MATERIALS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="opt"
                  aria-pressed={params.material === m.id}
                  onClick={() => patch({ material: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="hint tight">
              {params.material === 'paper'
                ? '「纸张」就是颜色校准时用的材质，颜色最准。'
                : '颜色校准是按「纸张」标的；实测金属材质导出后 Keynote 里色准依然准。补光越高，质感越看不出来。'}
            </p>
            {params.material !== 'paper' && (
              <>
                {/* 临时调杆：只调视口里的观感，往 Keynote 那种柔和的影棚光靠。一个都不进文件。
                    用户调到满意后把下面这行数值发回来写死，这一块就撤。 */}
                <p className="hint tight">
                  <b>预览调校（只影响视口，不进文件）。</b>把反光调到和 Keynote 里一样柔和，
                  然后把这行数值发给我：
                  <code>
                    {' '}env {params.previewTune.env.toFixed(2)} · blur {params.previewTune.blur.toFixed(2)} · direct{' '}
                    {params.previewTune.direct.toFixed(2)} · exposure {params.previewTune.exposure.toFixed(2)}
                  </code>
                </p>
                <Slider
                  label="环境反射强度"
                  reset={DEFAULT_PREVIEW_TUNE.env}
                  value={params.previewTune.env}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ previewTune: { ...params.previewTune, env: v } })}
                />
                <Slider
                  label="环境光带宽度"
                  reset={DEFAULT_PREVIEW_TUNE.blur}
                  value={params.previewTune.blur}
                  min={0}
                  max={1}
                  step={0.02}
                  onChange={(v) => patch({ previewTune: { ...params.previewTune, blur: v } })}
                />
                <Slider
                  label="直射光强度"
                  reset={DEFAULT_PREVIEW_TUNE.direct}
                  value={params.previewTune.direct}
                  min={0}
                  max={1.5}
                  step={0.05}
                  onChange={(v) => patch({ previewTune: { ...params.previewTune, direct: v } })}
                />
                <Slider
                  label="色调映射曝光（0 = 关）"
                  reset={DEFAULT_PREVIEW_TUNE.exposure}
                  value={params.previewTune.exposure}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ previewTune: { ...params.previewTune, exposure: v } })}
                />
              </>
            )}
          </div>
        </section>

        {isPrism && (
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
              {/* 左端排在左边、右端排在右边，和默认视角下模型上看到的一致 */}
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
              <input
                type="color"
                aria-label="两端颜色"
                value={params.capColorRight}
                onChange={(e) => patch({ capColorRight: e.target.value })}
              />
              <span>{params.separateCaps ? '右端' : '两端'}</span>
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
        )}

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
          target={params.target}
          setTarget={setTarget}
          store={store}
          selected={selected}
          hasImage={hasImage}
          tick={tick}
          onExportChart={onExportChart}
          shapeLabel={params.modelType === 'card' ? '卡片' : '棱柱'}
          modelType={params.modelType}
          unlit={params.emissiveExport}
          setUnlit={(v) => patch({ emissiveExport: v })}
          lift={params.emissiveLift ?? 0}
          setLift={(v) => patch({ emissiveLift: v })}
        />

        {/* 不要标题、不要上面那条分隔线 —— 到这儿已经是面板最底下了 */}
        </>
        )}
        {mode !== 'recolor' && (
        <section className="export-block">
          <div className="export-meta">
            <span>预估大小</span>
            <b>{sizeText}</b>
          </div>
          <p className="hint tight">文件直接存进「下载」文件夹，不弹保存框。</p>
          <button className="btn-primary" onClick={onExport} disabled={busy !== null}>
            {busy ?? '导出 USDZ'}
          </button>
        </section>
        )}
      </div>
    </aside>
  );
}
