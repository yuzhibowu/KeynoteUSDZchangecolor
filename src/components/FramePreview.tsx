import { useEffect, useRef } from 'react';
import type { FaceTextureStore } from '../lib/faceTexture';

/**
 * 侧栏里的取景框：这里、而且只有这里，能用鼠标挪动面里的那张图。
 *
 * 视口里绝不做这件事 —— 想转模型结果图跟着窜，是最难用的一种交互。
 * 这里画的就是那个面烘好的画布本身，所见即所得。
 */
export function FramePreview({
  store,
  index,
  tick,
  onPan,
}: {
  store: FaceTextureStore;
  index: number;
  tick: number;
  /** 拖动量，单位是「画布宽/高的几分之几」，和 offsetX / offsetY 同一套坐标 */
  onPan: (dx: number, dy: number, commit: boolean) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const src = store.canvases[index];
    // 按原比例摆，别拉成方的：宽高都显式写死。
    // CSS 里如果留着 width:100%，画布会被横向撑满，画进去的内容就变形了。
    const box = el.parentElement?.clientWidth || 260;
    const k = Math.min(box / src.width, 300 / src.height);
    const w = Math.max(1, Math.round(src.width * k));
    const h = Math.max(1, Math.round(src.height * k));
    const dpr = Math.min(2, window.devicePixelRatio);
    el.width = w * dpr;
    el.height = h * dpr;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
  }, [store, index, tick]);

  return (
    <div className="frame-wrap">
    <canvas
      ref={ref}
      className="frame-preview"
      title="按住拖动可以挪动这张图"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        drag.current = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // 往右拖 → 图往右走；y 要反过来，offsetY 是向上为正
        onPan((e.clientX - d.x) / d.w, -(e.clientY - d.y) / d.h, false);
        drag.current = { ...d, x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        if (drag.current) onPan(0, 0, true); // 收尾提交一次，进撤销/存档
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
    </div>
  );
}
