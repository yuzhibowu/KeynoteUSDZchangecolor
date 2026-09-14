import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { normalizeUsdzForLoader } from '../lib/recolor';
import { frameCamera, loadUsdz, makeScene } from '../lib/usdzScene';
import { bakeMotion, motionReach, pathAt, poseAt, effectiveLap, type MotionParams } from '../lib/motion';
import { FRAME_MEMORY_LIMIT, checkCancelled, waitForExport } from '../lib/videoExport';
import type { Pt } from '../lib/drawnPath';
import type { ModelSpace } from '../lib/motionExport';

/** 逐帧抓透明 PNG，给导视频用。挂在 ref 上，App 那边调 */
export type FrameRenderer = {
  maxTextureSize: number;
  render(opts: {
    width: number;
    height: number;
    fps: number;
    seconds: number;
    signal: AbortSignal;
    onProgress: (done: number, total: number) => void;
  }): Promise<Blob[]>;
};

/**
 * 一块预览：一个模型按当前参数实时运动。导入几个模型就有几块，每块自己一个渲染器。
 *
 * 场景层级是 orbit（用户拖动的视角）→ mover（运动函数给的姿态）→ 模型（已平移到包围盒中心）。
 * 视角在最外层：拖动等于绕着整个运动转，运动的轴不跟着视角变 —— 导出时也是这样。
 *
 * 参数改了不重新加载模型：poseAt 是纯函数，每帧拿最新参数算就行。
 */
function MotionTile({
  source,
  label,
  motion,
  onLoaded,
  background,
  slide,
  zoom,
  frameRef,
  drawing,
  onDrawn,
}: {
  source: ArrayBuffer;
  /** 角上的名字，多块的时候还带着错开值 */
  label: string;
  /** 这一块用的参数（相位已经错开过） */
  motion: MotionParams;
  /** 模型加载完了（或者失败了）告诉外面：导出要用加载器的变换和包围盒 */
  onLoaded: (space: ModelSpace | null, error: string | null) => void;
  background: string;
  slide: boolean;
  zoom: number;
  /** 导视频时从这里逐帧抓图；只有第一块给了 */
  frameRef: MutableRefObject<FrameRenderer | null> | null;
  drawing: boolean;
  onDrawn: (pts: Pt[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const bgRef = useRef(background);
  bgRef.current = background;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  useEffect(() => {
    rendererRef.current?.setClearColor(new THREE.Color(background));
  }, [background]);
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  // 进入手绘就把视角回正：画在正对着的那个平面上，画的和走的才是一回事
  const viewRef = useRef({ yaw: 0.35, pitch: 0.18 });
  useEffect(() => {
    if (drawing) viewRef.current = { yaw: 0, pitch: 0 };
  }, [drawing]);
  // 换了入场方式或时长就把时钟归零 —— 不然要等到下一圈才看得到入场
  const restartRef = useRef(0);
  useEffect(() => {
    restartRef.current = performance.now();
  }, [motion.entrance, motion.entranceSeconds, motion.seconds]);

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

      part = makeScene(host, { transparent: true });
      part.renderer.setClearColor(new THREE.Color(bgRef.current), 1);
      rendererRef.current = part.renderer;
      // 旋转轴要在包围盒中心 —— 第三方模型的原点经常在脚底或某个角上
      obj.position.sub(center);
      const mover = new THREE.Group();
      mover.add(obj);
      part.pivot.add(mover);

      // 路径线：预设轨迹画一圈，手绘画那一笔。挂在 pivot 下，跟着视角转
      const lineGeo = new THREE.BufferGeometry();
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.8 }));
      line.frustumCulled = false;
      part.pivot.add(line);
      let lineKey = '';
      const setLine = (pts: THREE.Vector3[]) => {
        lineGeo.setFromPoints(pts);
        line.visible = pts.length > 1;
      };
      const refreshLine = () => {
        const m = motionRef.current;
        const key = JSON.stringify([m.path, m.pathSize, m.pathAspect, m.pathClockwise, m.customPath, m.customClosed, m.seconds, m.pathLap]);
        if (key === lineKey) return;
        lineKey = key;
        if (m.path === 'none' || (m.path === 'custom' && m.customPath.length === 0)) return setLine([]);
        const lap = effectiveLap(m);
        const n = 160;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= n; i++) {
          const a = pathAt(m, (lap * i) / n, radius);
          pts.push(new THREE.Vector3(a.x, a.y, 0));
        }
        setLine(pts);
      };

      // 屏幕点 → 模型所在的 XY 平面（pivot 空间；手绘时视角已回正，所以就是世界坐标）
      const ray = new THREE.Raycaster();
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const toPlane = (e: PointerEvent): Pt | null => {
        if (!part) return null;
        const r = host.getBoundingClientRect();
        const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(nd, part.camera);
        const hit = new THREE.Vector3();
        if (!ray.ray.intersectPlane(plane, hit)) return null;
        return [hit.x / radius, hit.y / radius];
      };
      let stroke: Pt[] = [];

      let framedKey = '';
      let exporting = false;
      const frameKey = () => `${motionReach(motionRef.current, radius)}/${zoomRef.current}`;
      const resize = () => {
        if (!part || exporting) return;
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        part.renderer.setSize(w, h);
        part.camera.aspect = w / h;
        // 取景要把整段运动装下：轨迹开大了模型会跑出画面。zoom 再在这个基础上拉近
        framedKey = frameKey();
        frameCamera(part.camera, (radius + motionReach(motionRef.current, radius)) / zoomRef.current, 1.1);
      };
      const applyPose = (pose: ReturnType<typeof poseAt>) => {
        mover.position.set(pose.position[0], pose.position[1], pose.position[2]);
        mover.scale.setScalar(pose.scale);
        // USD 的 rotateXYZ 是 Rx·Ry·Rz（行向量），对应 three 的 'ZYX' —— 和导出一致
        mover.rotation.set(
          THREE.MathUtils.degToRad(pose.rotation[0]),
          THREE.MathUtils.degToRad(pose.rotation[1]),
          THREE.MathUtils.degToRad(pose.rotation[2]),
          'ZYX',
        );
      };

      // 导视频：按 bakeMotion 烘出来的姿态逐帧渲染、抓成透明 PNG。
      // 和写进 usdz 的是同一批姿态，接缝同样闭合。渲染尺寸临时切到输出尺寸，抓完还原。
      if (frameRef) frameRef.current = {
        maxTextureSize: part.renderer.capabilities.maxTextureSize,
        async render({ width, height, fps, seconds, signal, onProgress }) {
          if (!part) throw new Error('视口还没准备好');
          exporting = true;
          const r = part.renderer;
          const cam = part.camera;
          const prevRatio = r.getPixelRatio();
          const prevSize = r.getSize(new THREE.Vector2());
          const bg = new THREE.Color();
          r.getClearColor(bg);
          const frames: Blob[] = [];
          let bytes = 0;
          try {
            r.setPixelRatio(1);
            r.setSize(width, height, false);
            cam.aspect = width / height;
            frameCamera(cam, (radius + motionReach(motionRef.current, radius)) / zoomRef.current, 1.1);
            r.setClearColor(0x000000, 0);
            line.visible = false;
            const poses = bakeMotion(motionRef.current, radius, seconds, fps);
            const total = Math.max(1, Math.round(seconds * fps)); // 最后一帧和第 0 帧重合，不要
            for (let i = 0; i < total; i++) {
              checkCancelled(signal);
              applyPose(poses[i]);
              part.pivot.rotation.set(viewRef.current.pitch, viewRef.current.yaw, 0);
              r.render(part.scene, cam);
              const blob = await waitForExport(
                new Promise<Blob>((res, rej) => r.domElement.toBlob((b) => (b ? res(b) : rej(new Error('抓不到透明 PNG 帧'))), 'image/png')),
                signal,
              );
              bytes += blob.size;
              if (bytes > FRAME_MEMORY_LIMIT) throw new Error('帧数据到内存保护上限了，把尺寸、帧率降一档或缩短循环');
              frames.push(blob);
              onProgress(i + 1, total);
              await waitForExport(new Promise((res) => setTimeout(res, 0)), signal);
            }
            return frames;
          } finally {
            exporting = false;
            r.setPixelRatio(prevRatio);
            r.setSize(prevSize.x, prevSize.y, false);
            r.setClearColor(bg, 1);
            line.visible = true;
            lineKey = '';
            resize();
          }
        },
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      setBusy(false);
      onLoaded(space, null);

      restartRef.current = performance.now();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        if (!part) return;
        const t = (performance.now() - restartRef.current) / 1000;
        // 参数改了运动范围或取景就重新取景（每帧比一次字符串，便宜）
        if (frameKey() !== framedKey) resize();
        if (exporting) return; // 导视频时画面归导出那边管
        if (stroke.length === 0) refreshLine();
        applyPose(poseAt(motionRef.current, t, radius));
        part.pivot.rotation.set(viewRef.current.pitch, viewRef.current.yaw, 0);
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
        if (drawingRef.current) {
          const p = toPlane(e);
          stroke = p ? [p] : [];
          lineKey = '';
        }
      };
      const move = (e: PointerEvent) => {
        if (!dragging) return;
        if (drawingRef.current) {
          const p = toPlane(e);
          if (p) {
            stroke.push(p);
            // 边画边显示这一笔
            setLine(stroke.map(([x, y]) => new THREE.Vector3(x * radius, y * radius, 0)));
          }
          return;
        }
        viewRef.current.yaw += (e.clientX - lastX) * 0.01;
        viewRef.current.pitch = Math.max(-1.4, Math.min(1.4, viewRef.current.pitch + (e.clientY - lastY) * 0.01));
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const up = () => {
        if (!dragging) return;
        dragging = false;
        if (drawingRef.current && stroke.length > 1) {
          const done = stroke;
          stroke = [];
          onDrawnRef.current(done);
        } else stroke = [];
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
      if (frameRef) frameRef.current = null;
      if (part) {
        part.renderer.dispose();
        part.renderer.domElement.remove();
        rendererRef.current = null;
      }
    };
  }, [source, onLoaded, frameRef]);

  return (
    <div className="motion-tile">
      {error ? (
        <div className="recolor-empty">
          <p className="hint warn">{label}：这个文件渲染不了（{error}）。</p>
        </div>
      ) : (
        <div className="motion-stage">
          {busy && <div className="motion-loading">正在加载…</div>}
          {drawing && !busy && <div className="motion-drawhint">按住拖一笔，松手就好</div>}
          <div
            ref={hostRef}
            className={['motion-view', drawing ? 'drawing' : '', slide ? 'slide' : ''].filter(Boolean).join(' ')}
          />
          <span className="motion-label">{label}</span>
        </div>
      )}
    </div>
  );
}

/** 批量时每块错开多少秒；导出也用这个数，看到的和导出的一样 */
export const PHASE_STEP = 1.7;

/**
 * 加动效模式的左侧区域：拖进来几个模型就分几块，每块各漂各的、带各自的错开值。
 * 手绘和导视频只认第一块（参数是共用的，画在哪块都一样）。
 */
export function MotionPane({
  sources,
  motion,
  onFiles,
  onLoaded,
  background,
  slide,
  zoom,
  frameRef,
  drawing,
  onDrawn,
}: {
  sources: { name: string; buf: ArrayBuffer }[];
  motion: MotionParams;
  onFiles: (files: File[]) => void;
  /** 第 i 个模型加载完了（或者失败了） */
  onLoaded: (index: number, space: ModelSpace | null, error: string | null) => void;
  /** 预览背景色（CSS 颜色）。只影响预览，不进文件 */
  background: string;
  /** 视口按 16:9 的幻灯片来框，看的就是放进 Keynote 的样子 */
  slide: boolean;
  /** 取景缩放：1 是把整段运动的包围球刚好装下，大于 1 拉近 */
  zoom: number;
  /** 导视频时从这里逐帧抓图 */
  frameRef: MutableRefObject<FrameRenderer | null>;
  /** 手绘模式：拖动是画路径而不是转视角 */
  drawing: boolean;
  /** 画完一笔。点是模型半径的倍数，XY 平面 */
  onDrawn: (pts: Pt[]) => void;
}) {
  const n = sources.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  // 每块一个稳定的回调，免得每次渲染都让所有块重新加载
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  const callbacks = useRef<((space: ModelSpace | null, error: string | null) => void)[]>([]);
  for (let i = 0; i < n; i++) {
    if (!callbacks.current[i]) callbacks.current[i] = (space, error) => loadedRef.current(i, space, error);
  }
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
        const fs = [...e.dataTransfer.files].filter((x) => /\.usdz$/i.test(x.name));
        if (fs.length === 0) return;
        e.preventDefault();
        onFiles(fs);
      }}
    >
      {n === 0 && (
        <div className="recolor-empty">
          <h2>把现成的 USDZ 拖进来</h2>
          <p className="hint">或者用右边的「选择 USDZ 文件」。可以一次拖好几个，原文件不会被改动。</p>
        </div>
      )}
      {n > 0 && (
        <div className="motion-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {sources.map((src, i) => (
            <MotionTile
              key={`${i}:${src.name}:${src.buf.byteLength}`}
              source={src.buf}
              label={n > 1 ? `${src.name} · 错开 +${(i * PHASE_STEP).toFixed(1)} 秒` : src.name}
              motion={i === 0 ? motion : { ...motion, phase: motion.phase + i * PHASE_STEP }}
              onLoaded={callbacks.current[i]}
              background={background}
              slide={slide}
              zoom={zoom}
              frameRef={i === 0 ? frameRef : null}
              drawing={drawing && i === 0}
              onDrawn={onDrawn}
            />
          ))}
        </div>
      )}
    </div>
  );
}
