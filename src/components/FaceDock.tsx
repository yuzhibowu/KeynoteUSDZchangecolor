import { useEffect, useRef } from 'react';
import type { FaceTextureStore } from '../lib/faceTexture';
import { MAX_SIDES, type FaceState } from '../lib/types';

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
  onSelect: (i: number) => void;
  onFiles: (files: File[], faceIndex: number) => void;
};

/**
 * 预览下方的一排面缩略图。
 *
 * 每一格既是「选中这个面」，也是「给这个面导入图片」—— 右下角那个加号点了就开文件框，
 * 从访达直接拖图片到格子上也行。所以不需要再单独放一个「导入图片」按钮。
 */
export function FaceDock({ store, faces, sides, selected, tick, onSelect, onFiles }: Props) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const hidden: number[] = [];
  for (let i = sides; i < MAX_SIDES; i++) if (faces[i].source) hidden.push(i);

  return (
    <div className="dock-wrap">
      <div className="dock">
        {Array.from({ length: sides }, (_, i) => (
          <div
            key={i}
            className={`face-cell${selected === i ? ' on' : ''}`}
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
              onFiles(files, i);
            }}
          >
            <button
              type="button"
              className="face-pick"
              aria-pressed={selected === i}
              aria-label={`第 ${i} 个面${faces[i].sourceName ? '：' + faces[i].sourceName : ''}`}
              onClick={() => onSelect(i)}
              title={faces[i].sourceName ?? `第 ${i} 个面`}
            >
              <Thumb store={store} index={i} tick={tick} />
            </button>
            <button
              type="button"
              className="face-add"
              aria-label={`给第 ${i} 个面导入图片`}
              title="导入图片"
              onClick={() => inputs.current[i]?.click()}
            >
              +
            </button>
            <input
              ref={(el) => {
                inputs.current[i] = el;
              }}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) onFiles(files, i);
              }}
            />
            <i>{i}</i>
          </div>
        ))}
      </div>
      {hidden.length > 0 && (
        <p className="dock-note">第 {hidden.join('、')} 个面的贴图还在内存里，把边数加回去就会回来</p>
      )}
    </div>
  );
}
