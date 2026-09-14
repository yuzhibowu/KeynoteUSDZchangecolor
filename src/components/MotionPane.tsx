import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { normalizeUsdzForLoader } from '../lib/recolor';
import { frameCamera, loadUsdz, makeScene } from '../lib/usdzScene';
import { poseAt, type MotionParams } from '../lib/motion';
import type { ModelSpace } from '../lib/motionExport';

/**
 * 加动效模式的左侧区域：一个视口，模型按当前参数实时运动。
 *
 * 场景层级是 orbit（用户拖动的视角）→ mover（运动函数给的姿态）→ 模型（已平移到包围盒中心）。
 * 视角在最外层：拖动等于绕着整个运动转，运动的轴不跟着视角变 —— 导出时也是这样。
 *
 * 参数改了不重新加载模型：poseAt 是纯函数，每帧拿最新参数算就行。
 */
export function MotionPane({
  fileName,
  source,
  motion,
  onFile,
  onLoaded,
}: {
  fileName: string | null;
  source: ArrayBuffer | null;
  motion: MotionParams;
  onFile: (f: File) => void;
  /** 模型加载完了（或者失败了）告诉外面：导出要用加载器的变换和包围盒 */
  onLoaded: (space: ModelSpace | null, error: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !source) return;
    let alive = true;
    let raf = 0;
    let cleanup: (() => void) | null = null;
    let part: ReturnType<typeof makeScene> | null = null;
    setError(null);
    setBusy(true);

    (async () => {
      let obj: THREE.Object3D;
      try {
        // 加载器会改传进去的 buffer 吗？不确定，给一份拷贝更保险
        obj = await loadUsdz(normalizeUsdzForLoader(source.slice(0)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (alive) {
          setError(msg);
          setBusy(false);
          onLoaded(null, msg);
        }
        return;
      }
      if (!alive) return;

      // 加载器会给整个模型套 metersPerUnit 缩放和 Z-up 转 Y-up 的旋转，
      // 导出时要用它把运动换算回文件坐标 —— 在挪动之前先记下来
      obj.updateMatrix();
      const groupMatrix = obj.matrix.toArray();
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(1e-4, size.length() / 2);
      const space: ModelSpace = {
        groupMatrix,
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      };

      part = makeScene(host);
      // 旋转轴要在包围盒中心 —— 第三方模型的原点经常在脚底或某个角上
      obj.position.sub(center);
      const mover = new THREE.Group();
      mover.add(obj);
      part.pivot.add(mover);

      const resize = () => {
        if (!part) return;
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        part.renderer.setSize(w, h);
        part.camera.aspect = w / h;
        // 留得比对比视口宽一点：模型会上下漂，别让它顶到边
        frameCamera(part.camera, radius, 1.45);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      setBusy(false);
      onLoaded(space, null);

      let yaw = 0.35;
      let pitch = 0.18;
      const t0 = performance.now();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        if (!part) return;
        const t = (performance.now() - t0) / 1000;
        const pose = poseAt(motionRef.current, t, radius);
        mover.position.set(pose.position[0], pose.position[1], pose.position[2]);
        // USD 的 rotateXYZ 是 Rx·Ry·Rz（行向量），对应 three 的 'ZYX' —— 和导出一致
        mover.rotation.set(
          THREE.MathUtils.degToRad(pose.rotation[0]),
          THREE.MathUtils.degToRad(pose.rotation[1]),
          THREE.MathUtils.degToRad(pose.rotation[2]),
          'ZYX',
        );
        part.pivot.rotation.set(pitch, yaw, 0);
        part.renderer.render(part.scene, part.camera);
      };
      loop();

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const down = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        host.setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!dragging) return;
        yaw += (e.clientX - lastX) * 0.01;
        pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - lastY) * 0.01));
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const up = () => {
        dragging = false;
      };
      host.addEventListener('pointerdown', down);
      host.addEventListener('pointermove', move);
      host.addEventListener('pointerup', up);
      host.addEventListener('pointercancel', up);
      cleanup = () => {
        ro.disconnect();
        host.removeEventListener('pointerdown', down);
        host.removeEventListener('pointermove', move);
        host.removeEventListener('pointerup', up);
        host.removeEventListener('pointercancel', up);
      };
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      cleanup?.();
      if (part) {
        part.renderer.dispose();
        part.renderer.domElement.remove();
      }
    };
  }, [source, onLoaded]);

  return (
    <div
      className="recolor motion"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
      onDrop={(e) => {
        e.currentTarget.classList.remove('drag-over');
        const f = [...e.dataTransfer.files].find((x) => /\.usdz$/i.test(x.name));
        if (!f) return;
        e.preventDefault();
        onFile(f);
      }}
    >
      {!fileName && (
        <div className="recolor-empty">
          <h2>把现成的 USDZ 拖进来</h2>
          <p className="hint">或者用右边的「选择 USDZ 文件」。原文件不会被改动。</p>
        </div>
      )}
      {fileName && error && (
        <div className="recolor-empty">
          <p className="hint warn">这个文件渲染不了（{error}）。</p>
        </div>
      )}
      {fileName && !error && (
        <div className="motion-stage">
          {busy && <div className="motion-loading">正在加载…</div>}
          <div ref={hostRef} className="motion-view" />
        </div>
      )}
    </div>
  );
}
