import { useEffect, useRef, useState } from 'react';
import { PrismViewer } from '../lib/viewer';
import type { FaceTextureStore } from '../lib/faceTexture';
import type { FaceState, FaceTransform, Params } from '../lib/types';

type Props = {
  store: FaceTextureStore;
  params: Params;
  faces: FaceState[];
  selected: number | null;
  onSelect: (i: number | null) => void;
  onTransform: (i: number, t: FaceTransform, commit: boolean) => void;
  onDropFiles: (files: File[], faceIndex: number | null) => void;
  viewerRef: React.MutableRefObject<PrismViewer | null>;
};

export function Viewport({ store, params, faces, selected, onSelect, onTransform, onDropFiles, viewerRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef({ onSelect, onTransform });
  cbRef.current = { onSelect, onTransform };
  const [dropFace, setDropFace] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current!;
    const viewer = new PrismViewer(host, store, {
      onSelect: (i) => cbRef.current.onSelect(i),
      onTransform: (i, t, commit) => cbRef.current.onTransform(i, t, commit),
    });
    viewerRef.current = viewer;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__viewer = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [store, viewerRef]);

  useEffect(() => {
    viewerRef.current?.update({ params, faces, selected });
  }, [params, faces, selected, viewerRef]);

  const dropping = dropFace !== undefined;

  return (
    <div
      ref={hostRef}
      className={`viewport${dropping ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropFace(viewerRef.current?.faceAtClient(e.clientX, e.clientY) ?? null);
      }}
      onDragLeave={() => setDropFace(undefined)}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) {
          setDropFace(undefined);
          return;
        }
        e.preventDefault();
        const face = viewerRef.current?.faceAtClient(e.clientX, e.clientY) ?? null;
        setDropFace(undefined);
        onDropFiles(files, face);
      }}
    >
      {dropping && (
        <div className="drop-hint">
          {dropFace === null ? '松手 → 从第 0 个面开始依次分配' : `松手 → 贴到第 ${dropFace} 个面`}
        </div>
      )}
      {/* 范式：恢复视角这类辅助操作贴近预览边角 */}
      <div className="stage-tools">
        <button
          className="btn"
          onClick={() => selected !== null && viewerRef.current?.faceOn(selected)}
          disabled={selected === null}
        >
          正对当前面
        </button>
        <button className="btn" onClick={() => viewerRef.current?.resetRotation()}>
          重置角度
        </button>
      </div>
    </div>
  );
}
