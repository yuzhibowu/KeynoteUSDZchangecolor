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
  /** 导出期间盖在预览上的静止画面，避免用户看到贴图被补偿得发暗 */
  frozen: string | null;
  onResetFace: () => void;
  onClearFace: () => void;
  onClearAll: () => void;
  onTestFill: () => void;
};

function PoseInput({ viewerRef }: { viewerRef: React.MutableRefObject<PrismViewer | null> }) {
  const [v, setV] = useState({ x: '0', y: '0', z: '0' });
  const apply = (next: typeof v) => {
    setV(next);
    const n = (s: string) => {
      const k = Number(s);
      return Number.isFinite(k) ? k : 0;
    };
    viewerRef.current?.setPose(n(next.x), n(next.y), n(next.z));
  };
  return (
    <span className="pose" title="照着 Keynote「3D 旋转」面板里的 X / Y / Z 角度填，视口就摆成同一个姿态">
      {(['x', 'y', 'z'] as const).map((k) => (
        <label key={k}>
          {k.toUpperCase()}
          <input
            type="number"
            step={0.1}
            value={v[k]}
            onChange={(e) => apply({ ...v, [k]: e.target.value })}
          />
          °
        </label>
      ))}
    </span>
  );
}

export function Viewport({
  store,
  params,
  faces,
  selected,
  onSelect,
  onTransform,
  onDropFiles,
  viewerRef,
  frozen,
  onResetFace,
  onClearFace,
  onClearAll,
  onTestFill,
}: Props) {
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
  const hasImage = selected !== null && !!faces[selected]?.source;
  // 「移除图片」只管当前这一面，剩下的面从别的角度还看得见 —— 所以再给一个一次清干净的入口
  const hasAnyImage = faces.some((f) => !!f.source);

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
      {frozen && <img className="viewport-freeze" src={frozen} alt="" />}
      {dropping && (
        <div className="drop-hint">
          {dropFace === null ? '松手 → 从第 1 个面开始依次分配' : `松手 → 贴到第 ${dropFace + 1} 个面`}
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
      {/* 精确姿态：照着 Keynote「3D 旋转」面板填 X/Y/Z，两边在同一个姿态下比反光。单独一行，别挤按钮 */}
      <div className="stage-tools top">
        <PoseInput viewerRef={viewerRef} />
      </div>
      {/* 贴图操作也贴边放，右下角一排 —— 侧栏里那一段就不再重复了 */}
      <div className="stage-tools right">
        <button className="btn" onClick={onResetFace} disabled={!hasImage}>
          重置此面
        </button>
        <button className="btn" onClick={onClearFace} disabled={!hasImage}>
          移除图片
        </button>
        <button
          className="btn"
          onClick={onClearAll}
          disabled={!hasAnyImage}
          title="把所有面上的图片一次清掉 —— 一批图会被依次铺到多个面上，只移除当前这一面的话，剩下的从别的角度还看得见"
        >
          全部移除
        </button>
        <button
          className="btn"
          onClick={onTestFill}
          title="给每个面填一张纯色图（只有底色，不带编号），用来验证 Keynote 对「多 mesh 多材质」的支持"
        >
          填充纯色
        </button>
      </div>
    </div>
  );
}
