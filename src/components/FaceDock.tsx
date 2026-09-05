import { useEffect, useRef } from 'react';
import type { FaceTextureStore } from '../lib/faceTexture';
import { MAX_SIDES, type FaceState } from '../lib/types';

function Thumb({
  store,
  index,
  tick,
}: {
  store: FaceTextureStore;
  index: number;
  tick: number;
}) {
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
  onDropFiles: (files: File[], faceIndex: number) => void;
};

export function FaceDock({ store, faces, sides, selected, tick, onSelect, onDropFiles }: Props) {
  const hidden: number[] = [];
  for (let i = sides; i < MAX_SIDES; i++) if (faces[i].source) hidden.push(i);

  return (
    <div className="dock-wrap">
      <div className="dock">
        {Array.from({ length: sides }, (_, i) => (
          <button
            key={i}
            type="button"
            className="face-cell"
            aria-pressed={selected === i}
            aria-label={`第 ${i} 个面${faces[i].sourceName ? '：' + faces[i].sourceName : '（未贴图）'}`}
            onClick={() => onSelect(i)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              e.currentTarget.classList.add('drag-over');
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
            onDrop={(e) => {
              e.currentTarget.classList.remove('drag-over');
              const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
              if (files.length === 0) return;
              e.preventDefault();
              onDropFiles(files, i);
            }}
            title={faces[i].sourceName ?? '未贴图'}
          >
            <Thumb store={store} index={i} tick={tick} />
            <i>{i}</i>
          </button>
        ))}
      </div>
      {hidden.length > 0 && (
        <p className="dock-note">第 {hidden.join('、')} 个面的贴图还在内存里，把边数加回去就会回来</p>
      )}
    </div>
  );
}
