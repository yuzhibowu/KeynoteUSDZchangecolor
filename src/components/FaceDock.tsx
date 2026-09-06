import { useEffect, useRef } from 'react';
import type { FaceTextureStore } from '../lib/faceTexture';
import { CAP_LEFT, CAP_RIGHT, CARD_BACK, CARD_FRONT, innerSlot, isCap, MAX_SIDES, type FaceState } from '../lib/types';

function Thumb({ store, index, tick }: { store: FaceTextureStore; index: number; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const src = store.canvases[index];
    const dpr = Math.min(2, window.devicePixelRatio);
    const box = 96;
    el.width = box * dpr;
    el.height = box * dpr;
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box, box);
    const k = Math.min(box / src.width, box / src.height);
    const w = src.width * k;
    const h = src.height * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (box - w) / 2, (box - h) / 2, w, h);
  }, [store, index, tick]);
  return <canvas ref={ref} />;
}

type Props = {
  store: FaceTextureStore;
  faces: FaceState[];
  sides: number;
  selected: number | null;
  tick: number;
  /** 没有端面时才有内面可贴 —— 封了口本来就看不到里面 */
  showInner: boolean;
  /** 勾了「两端分别设置」才给两个端面各开一个贴图入口 */
  showCaps: boolean;
  /** 卡片模式：只有正反两面能贴图，四条窄边走纯色 */
  card: boolean;
  onSelect: (i: number) => void;
  onFiles: (files: File[], faceIndex: number) => void;
  /** 把某一格的图旋转 90°，dir = 1 顺时针、-1 逆时针 */
  onRotate: (slot: number, dir: 1 | -1) => void;
};

/**
 * 预览下方的一排面缩略图。
 *
 * 每一格既是「选中这个面」，也是「给这个面导入图片」—— 右下角那个加号点了就开文件框，
 * 从访达直接拖图片到格子上也行。所以不需要再单独放一个「导入图片」按钮。
 */
export function FaceDock({ store, faces, sides, selected, tick, showInner, showCaps, card, onSelect, onFiles, onRotate }: Props) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const hidden: number[] = [];
  if (!card) for (let i = sides; i < MAX_SIDES; i++) if (faces[i].source) hidden.push(i);

  const nameOf = (slot: number, faceIndex: number) =>
    card
      ? slot === CARD_FRONT
        ? '卡片正面'
        : '卡片背面'
      : isCap(slot)
        ? slot === CAP_RIGHT
          ? '右端面'
          : '左端面'
        : `第 ${faceIndex + 1} 个面的${slot === faceIndex ? '正面' : '反面'}`;

  const cell = (slot: number, faceIndex: number) => (
          <div
            key={slot}
            className={`face-cell${selected === slot ? ' on' : ''}${faces[slot].hidden ? ' off' : ''}`}
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
              e.stopPropagation();
              onFiles(files, slot);
            }}
          >
            <button
              type="button"
              className="face-pick"
              aria-pressed={selected === slot}
              aria-label={`${nameOf(slot, faceIndex)}${
                faces[slot].sourceName ? '：' + faces[slot].sourceName : ''
              }`}
              onClick={() => onSelect(slot)}
              title={`${faces[slot].sourceName ?? nameOf(slot, faceIndex)}${faces[slot].hidden ? '（不显示）' : ''}`}
            >
              <Thumb store={store} index={slot} tick={tick} />
            </button>
            <button
              type="button"
              className="face-add"
              aria-label={`给${nameOf(slot, faceIndex)}导入图片`}
              title="导入图片"
              onClick={() => inputs.current[slot]?.click()}
            >
              +
            </button>
            {faces[slot].source && (
              <>
                <button
                  type="button"
                  className="face-rot left"
                  aria-label={`${nameOf(slot, faceIndex)}逆时针转 90°`}
                  title="逆时针转 90°"
                  onClick={() => onRotate(slot, -1)}
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="face-rot right"
                  aria-label={`${nameOf(slot, faceIndex)}顺时针转 90°`}
                  title="顺时针转 90°"
                  onClick={() => onRotate(slot, 1)}
                >
                  ↻
                </button>
              </>
            )}
            <input
              ref={(el) => {
                inputs.current[slot] = el;
              }}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) onFiles(files, slot);
              }}
            />
            {/* 给人看的编号从 1 起，内部索引还是 0 起 */}
            <i>
              {card
                ? slot === CARD_FRONT
                  ? '正'
                  : '背'
                : isCap(slot)
                  ? slot === CAP_RIGHT
                    ? '右'
                    : '左'
                  : faceIndex + 1}
            </i>
          </div>
  );

  return (
    <div className="dock-wrap">
      <div className="dock-row">
        {showInner && <span className="dock-label">正面</span>}
        <div className="dock">
          {/* 端面排在最左边，左端在左、右端在右 —— 和默认视角下模型上看到的一致 */}
          {showCaps && cell(CAP_LEFT, CAP_LEFT)}
          {showCaps && cell(CAP_RIGHT, CAP_RIGHT)}
          {card
            ? [cell(CARD_FRONT, CARD_FRONT), cell(CARD_BACK, CARD_BACK)]
            : Array.from({ length: sides }, (_, i) => cell(i, i))}
        </div>
      </div>
      {showInner && (
        <div className="dock-row">
          <span className="dock-label">反面</span>
          <div className="dock">{Array.from({ length: sides }, (_, i) => cell(innerSlot(i), i))}</div>
        </div>
      )}
      {hidden.length > 0 && (
        <p className="dock-note">
          第 {hidden.map((i) => i + 1).join('、')} 个面的贴图还在内存里，把边数加回去就会回来
        </p>
      )}
    </div>
  );
}
