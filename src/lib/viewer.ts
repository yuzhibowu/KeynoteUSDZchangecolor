import * as THREE from 'three';
import { capGeometry, faceCenterAngle, faceFrame, sideGeometry, type FaceFrame } from './geometry';
import { compensateToLinear, srgbToLinear } from './color';

function hexToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}
import { clampTransform, type FaceTextureStore } from './faceTexture';
import { MAX_SIDES, faceAspect, type FaceState, type FaceTransform, type Params } from './types';

type ViewerState = { params: Params; faces: FaceState[]; selected: number | null };

export type ViewerCallbacks = {
  onSelect: (index: number | null) => void;
  onTransform: (index: number, t: FaceTransform, commit: boolean) => void;
};

type Drag =
  | { kind: 'none' }
  | { kind: 'rotate'; lastX: number; lastY: number }
  | {
      kind: 'pan' | 'pinch';
      face: number;
      frame: FaceFrame;
      plane: THREE.Plane;
      start: FaceTransform;
      startLocal: { u: number; v: number };
      startDist: number;
    };

const TAU = Math.PI * 2;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const SCRATCH = new THREE.Vector3();
const Q_A = new THREE.Quaternion();
const Q_B = new THREE.Quaternion();

/** 把 target 折算成离 current 最近的等价角度，避免转最长的那条路 */
function shortestTo(current: number, target: number): number {
  const d = (((target - current) % TAU) + TAU + Math.PI) % TAU - Math.PI;
  return current + d;
}

const DEFAULT_YAW = -0.32;
const DEFAULT_SPIN = 0.22;

export class PrismViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 承载旋转的分组：相机固定不动，转的是它 */
  readonly pivot = new THREE.Group();
  /** 只装棱柱本体的分组 —— 导出的就是它，天然不含辅助对象 */
  readonly prism = new THREE.Group();

  private container: HTMLElement;
  private store: FaceTextureStore;
  private cb: ViewerCallbacks;

  private sideMeshes: THREE.Mesh[] = [];
  private sideMaterials: THREE.MeshStandardMaterial[] = [];
  private capRight: THREE.Mesh;
  private capLeft: THREE.Mesh;
  private capRightMat: THREE.MeshStandardMaterial;
  private capLeftMat: THREE.MeshStandardMaterial;
  private outline: THREE.Mesh;
  private hoverline: THREE.Mesh;
  private grid: THREE.GridHelper;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag = { kind: 'none' };
  private hovered: number | null = null;

  // 旋转：yaw 绕世界 Y（左右拖），spin 绕棱柱自己的长轴（上下拖）
  private yaw = DEFAULT_YAW;
  private spin = DEFAULT_SPIN;
  private curYaw = DEFAULT_YAW;
  private curSpin = DEFAULT_SPIN;
  private canonical = false; // 导出期间把旋转临时归零
  /**
   * 补光只在导出时生效。视口里三条光和 Keynote 不是一套，再叠补光会显得过曝，
   * 反而离「Keynote 里的样子」更远 —— 预览保持普通光照，更接近最终观感。
   */
  private exportMode = false;

  private state: ViewerState | null = null;
  private geomSig = '';
  private raf = 0;
  private ro: ResizeObserver;

  constructor(container: HTMLElement, store: FaceTextureStore, cb: ViewerCallbacks) {
    this.container = container;
    this.store = store;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x14161a, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';

    // 相机固定：正对 +Z，只在几何变化时调距离让物体占满画面
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.005, 100);
    this.camera.position.set(0, 0, 0.4);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 2.0));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404652, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-3, 1, -2);
    this.scene.add(fill);
    const bottom = new THREE.DirectionalLight(0xffffff, 0.35);
    bottom.position.set(0, -2, 0.5);
    this.scene.add(bottom);

    this.grid = new THREE.GridHelper(1, 20, 0x3a4150, 0x262b34);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.scene.add(this.pivot);
    this.pivot.add(this.prism);

    this.capRightMat = new THREE.MeshStandardMaterial({ color: 0xd9d9de, roughness: 0.85, metalness: 0 });
    this.capLeftMat = new THREE.MeshStandardMaterial({ color: 0xd9d9de, roughness: 0.85, metalness: 0 });
    this.capRightMat.name = 'cap_right';
    this.capLeftMat.name = 'cap_left';
    this.capRight = new THREE.Mesh(new THREE.BufferGeometry(), this.capRightMat);
    this.capLeft = new THREE.Mesh(new THREE.BufferGeometry(), this.capLeftMat);
    this.capRight.name = 'cap_right';
    this.capLeft.name = 'cap_left';
    this.prism.add(this.capRight, this.capLeft);

    for (let i = 0; i < MAX_SIDES; i++) {
      const mat = new THREE.MeshStandardMaterial({
        map: store.textures[i],
        roughness: 0.9, // 高粗糙度：压制高光对贴图颜色的干扰
        metalness: 0.0,
      });
      mat.name = `face_${i}`;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.name = `face_${i}`;
      mesh.userData.faceIndex = i;
      mesh.visible = false;
      this.sideMaterials.push(mat);
      this.sideMeshes.push(mesh);
      this.prism.add(mesh);
    }

    this.outline = makeOutline(0x5ac8fa, 0.045);
    this.hoverline = makeOutline(0xffffff, 0.02);
    this.outline.visible = false;
    this.hoverline.visible = false;
    this.pivot.add(this.outline, this.hoverline);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onWheel, { capture: true, passive: false });

    this.applyRotation(); // 初始角度要先落一次，阻尼循环只在有差值时才更新
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('wheel', this.onWheel, { capture: true } as EventListenerOptions);
    this.sideMeshes.forEach((m) => m.geometry.dispose());
    this.sideMaterials.forEach((m) => m.dispose());
    this.capRight.geometry.dispose();
    this.capLeft.geometry.dispose();
    this.renderer.dispose();
    if (el.parentElement) el.parentElement.removeChild(el);
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.state) this.fitCamera();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.canonical) {
      const dYaw = this.yaw - this.curYaw;
      const dSpin = this.spin - this.curSpin;
      if (Math.abs(dYaw) > 1e-5 || Math.abs(dSpin) > 1e-5) {
        // 指数阻尼永远到不了终点，差得够小就直接吸附过去
        this.curYaw = Math.abs(dYaw) < 1e-4 ? this.yaw : this.curYaw + dYaw * 0.25;
        this.curSpin = Math.abs(dSpin) < 1e-4 ? this.spin : this.curSpin + dSpin * 0.25;
        this.applyRotation();
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  private applyRotation() {
    Q_A.setFromAxisAngle(AXIS_Y, this.curYaw);
    Q_B.setFromAxisAngle(AXIS_X, this.curSpin);
    this.pivot.quaternion.copy(Q_A).multiply(Q_B);
    this.pivot.updateMatrixWorld(true);
  }

  /** 拖贴图之前先把阻尼动画走完，免得平面在拖的过程中还在飘 */
  private snapRotation() {
    this.curYaw = this.yaw;
    this.curSpin = this.spin;
    this.applyRotation();
  }

  update(next: ViewerState) {
    // faces 复制一份：拖拽时视口会就地改自己这份，不去动 React 的状态对象
    this.state = { ...next, faces: next.faces.slice() };
    const { params } = next;
    const sig = `${params.sides}|${params.radius}|${params.length}`;
    if (sig !== this.geomSig) {
      this.geomSig = sig;
      this.rebuildGeometry();
      this.fitCamera();
    }

    // 伪 unlit：diffuse 压黑、emissive 走同一张贴图。预览和导出用同一套材质设置，
    // 所以开关一打开，视口里看到的就是 Keynote 里会看到的。
    const unlit = params.emissiveExport;
    const lift = this.liftNow();
    for (let i = 0; i < MAX_SIDES; i++) {
      const m = this.sideMaterials[i];
      // 补光 > 0 时也要挂 emissiveMap，加法那一项才能逐像素跟着贴图走
      const wantEmissiveMap = lift > 0 ? this.store.textures[i] : null;
      if (m.emissiveMap !== wantEmissiveMap) {
        m.emissiveMap = wantEmissiveMap;
        m.needsUpdate = true;
      }
      m.emissive.setRGB(lift, lift, lift);
      m.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
    }
    this.applyCapColors(false);

    this.refreshOutline();
  }

  private rebuildGeometry() {
    const { sides, radius, length } = this.state!.params;
    for (let i = 0; i < MAX_SIDES; i++) {
      const mesh = this.sideMeshes[i];
      mesh.geometry.dispose();
      if (i < sides) {
        mesh.geometry = sideGeometry(i, sides, radius, length);
        mesh.visible = true;
      } else {
        mesh.geometry = new THREE.BufferGeometry();
        mesh.visible = false;
      }
    }
    this.capRight.geometry.dispose();
    this.capLeft.geometry.dispose();
    this.capRight.geometry = capGeometry(sides, radius, length, true);
    this.capLeft.geometry = capGeometry(sides, radius, length, false);
    this.grid.scale.setScalar(Math.max(radius * 10, length * 2.5));
    this.grid.position.y = -radius * 1.9;
  }

  /** 相机方向永远固定在 +Z，只按包围球调距离，保证物体始终占满画面 */
  fitCamera() {
    const { radius, length } = this.state!.params;
    const r = Math.hypot(length / 2, radius);
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 1.22;
    this.camera.position.set(0, 0, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.001, dist - r * 2);
    this.camera.far = dist + r * 6;
    this.camera.updateProjectionMatrix();
  }

  resetRotation() {
    this.yaw = shortestTo(this.yaw, DEFAULT_YAW);
    this.spin = shortestTo(this.spin, DEFAULT_SPIN);
  }

  /** 把某个侧面转到正对相机，贴图定位时最好用 */
  faceOn(index: number) {
    const st = this.state;
    if (!st) return;
    this.yaw = shortestTo(this.yaw, 0);
    this.spin = shortestTo(this.spin, faceCenterAngle(index, st.params.sides));
  }

  /**
   * 端面是纯色材质，没有贴图可烘，补偿直接改材质颜色。
   * 纯色不受 8 位限制，可以直接写 > 1 的线性值，不需要贴图那套增益。
   */
  private liftNow(): number {
    const p = this.state!.params;
    if (p.emissiveExport) return 1;
    return this.exportMode ? Math.max(0, Math.min(1, p.emissiveLift ?? 0)) : 0;
  }

  private applyCapColors(compensate: boolean) {
    const p = this.state!.params;
    const raw: [THREE.MeshStandardMaterial, string][] = [
      [this.capRightMat, p.capColorRight],
      [this.capLeftMat, p.separateCaps ? p.capColorLeft : p.capColorRight],
    ];
    const unlit = p.emissiveExport;
    const lift = this.liftNow();
    for (const [mat, hex] of raw) {
      const lin = compensate ? compensateToLinear(hex, p.color) : null;
      const base: [number, number, number] = lin ?? hexToLinear(hex);
      mat.color.setRGB(unlit ? 0 : base[0], unlit ? 0 : base[1], unlit ? 0 : base[2]);
      mat.emissive.setRGB(lift * base[0], lift * base[1], lift * base[2]);
    }
  }

  /**
   * 让侧面材质跟上当前状态：自发光该不该挂贴图、漫反射该不该压黑。
   *
   * 补光（自发光）只在导出时挂上 —— 视口的三条光和 Keynote 不是一套，
   * 再叠补光会显得过曝。所以 `liftNow()` 会看 `exportMode`。
   */
  syncSideMaterials() {
    const p = this.state!.params;
    const unlit = p.emissiveExport;
    const lift = this.liftNow();
    for (let i = 0; i < MAX_SIDES; i++) {
      const m = this.sideMaterials[i];
      // 挂当前的 map，不是 store 里那张。导出时 exportUsdz 会先把 map 换成一批全新的
      // texture 对象（为了不让 Keynote 按名字缓存旧贴图），如果这里仍然挂 store 的那张，
      // diffuse 和 emissive 就指向两个不同的 texture —— USDZExporter 按 source.id 建表，
      // 于是同样的像素在 usdz 里被存了两份，文件体积白白翻倍。
      const want = lift > 0 ? m.map ?? this.store.textures[i] : null;
      if (m.emissiveMap !== want) {
        m.emissiveMap = want;
        m.needsUpdate = true;
      }
      m.emissive.setRGB(lift, lift, lift);
      m.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
    }
  }

  /** 导出期间把旋转归零、端面颜色换成补偿后的值，让 usdz 里的模型是正的、颜色是补过的 */
  async runCanonical<T>(fn: () => Promise<T>): Promise<T> {
    this.canonical = true;
    this.exportMode = true;
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);
    this.applyCapColors(true);
    this.syncSideMaterials();
    try {
      return await fn();
    } finally {
      this.canonical = false;
      this.exportMode = false;
      this.applyRotation();
      this.applyCapColors(false);
      this.syncSideMaterials();
    }
  }

  private refreshOutline() {
    const st = this.state;
    if (!st) return;
    const { sides, radius, length } = st.params;
    const sel = st.selected;
    if (sel === null || sel >= sides) {
      this.outline.visible = false;
    } else {
      setOutline(this.outline, faceFrame(sel, sides, radius, length));
      this.outline.visible = true;
    }
    if (this.hovered === null || this.hovered >= sides || this.hovered === sel) {
      this.hoverline.visible = false;
    } else {
      setOutline(this.hoverline, faceFrame(this.hovered, sides, radius, length));
      this.hoverline.visible = true;
    }
  }

  // ---- 拾取 ----

  private setPointer(e: { clientX: number; clientY: number }) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** 屏幕坐标 → 侧面编号（端面不可选） */
  faceAtClient(clientX: number, clientY: number): number | null {
    if (!this.state) return null;
    this.setPointer({ clientX, clientY });
    const active = this.sideMeshes.slice(0, this.state.params.sides);
    const hits = this.raycaster.intersectObjects([...active, this.capRight, this.capLeft], false);
    if (hits.length === 0) return null;
    const idx = hits[0].object.userData.faceIndex;
    return typeof idx === 'number' ? idx : null;
  }

  /** 侧面在世界坐标下的局部基 —— 物体是转过的，所以要把局部基乘上 pivot 的旋转 */
  private worldFrame(index: number): FaceFrame {
    const { sides, radius, length } = this.state!.params;
    const f = faceFrame(index, sides, radius, length);
    const q = this.pivot.quaternion;
    f.center.applyQuaternion(q);
    f.normal.applyQuaternion(q);
    f.u.applyQuaternion(q);
    f.v.applyQuaternion(q);
    return f;
  }

  private localOnFace(frame: FaceFrame, plane: THREE.Plane): { u: number; v: number } | null {
    const hit = this.raycaster.ray.intersectPlane(plane, SCRATCH);
    if (!hit) return null;
    const d = hit.clone().sub(frame.center);
    return { u: d.dot(frame.u), v: d.dot(frame.v) };
  }

  private currentTransform(face: number): FaceTransform {
    const f = this.state!.faces[face];
    return { offsetX: f.offsetX, offsetY: f.offsetY, scale: f.scale, rotation: f.rotation };
  }

  private applyTransform(face: number, t: FaceTransform, commit: boolean) {
    const st = this.state!;
    const src = st.faces[face].source;
    const { w, h } = this.store.size(face);
    const clamped = src ? clampTransform(t, w, h, src.width, src.height) : t;
    // 视口里直接烘焙，不等 React 状态回流，拖拽才跟手
    const patched: FaceState = { ...st.faces[face], ...clamped };
    st.faces[face] = patched;
    // 用面的真实宽高比推画布尺寸，不要拿当前画布的 w/h 反推 —— 那个值是取整过的
    this.store.bake(face, patched, {
      aspect: faceAspect(st.params.radius, st.params.sides, st.params.length),
      resolution: st.params.resolution,
      bgColor: st.params.bgColor,
      comp: st.params.color,
      compensate: false, // 视口里看到的是「Keynote 里应该长成的样子」，补偿只在导出时烘进去
    });
    this.cb.onTransform(face, clamped, commit);
  }

  private beginTexturePan(face: number, e: { clientX: number; clientY: number }): boolean {
    this.snapRotation();
    const frame = this.worldFrame(face);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.center);
    this.setPointer(e);
    const local = this.localOnFace(frame, plane);
    if (!local) return false;
    this.drag = {
      kind: 'pan',
      face,
      frame,
      plane,
      start: this.currentTransform(face),
      startLocal: local,
      startDist: 0,
    };
    return true;
  }

  // ---- 交互 ----

  private onPointerDown = (e: PointerEvent) => {
    if (!this.state) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 第二根手指落下 → 捏合缩放贴图
    if (this.drag.kind === 'pan' && this.pointers.size === 2) {
      const face = this.drag.face;
      const mid = this.midpoint();
      if (mid) {
        this.setPointer(mid);
        const local = this.localOnFace(this.drag.frame, this.drag.plane);
        if (local) {
          this.drag = {
            ...this.drag,
            kind: 'pinch',
            start: this.currentTransform(face),
            startLocal: local,
            startDist: this.pointerDistance(),
          };
        }
      }
      return;
    }

    const hit = this.faceAtClient(e.clientX, e.clientY);
    const st = this.state;
    const grabTexture =
      hit !== null && hit === st.selected && st.faces[hit].source !== null && !e.shiftKey;

    this.renderer.domElement.setPointerCapture(e.pointerId);

    if (grabTexture && this.beginTexturePan(hit, e)) {
      this.renderer.domElement.style.cursor = 'grabbing';
      return;
    }

    if (hit !== null && hit !== st.selected) this.cb.onSelect(hit);
    // 其余一律是转物体（相机不动）
    this.drag = { kind: 'rotate', lastX: e.clientX, lastY: e.clientY };
    this.renderer.domElement.style.cursor = 'grabbing';
  };

  private midpoint(): { clientX: number; clientY: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    return { clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 };
  }

  private pointerDistance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.state) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.drag.kind === 'rotate') {
      // 相机固定，转的是物体：左右拖绕世界 Y，上下拖绕棱柱自己的长轴
      const dx = e.clientX - this.drag.lastX;
      const dy = e.clientY - this.drag.lastY;
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
      this.yaw += dx * 0.0075;
      this.spin += dy * 0.0075;
      return;
    }

    if (this.drag.kind === 'pan') {
      this.setPointer(e);
      const local = this.localOnFace(this.drag.frame, this.drag.plane);
      if (!local) return;
      const { frame, start, startLocal } = this.drag;
      // ray-plane 求交的差值 → 物理位移 → 归一化偏移。透视被自动处理掉，
      // 鼠标始终粘在贴图的同一个点上，拖出面的边界也不会丢追踪。
      const du = (local.u - startLocal.u) / frame.width;
      const dv = (local.v - startLocal.v) / frame.height;
      this.applyTransform(
        this.drag.face,
        { ...start, offsetX: start.offsetX + du, offsetY: start.offsetY + dv },
        false,
      );
      return;
    }

    if (this.drag.kind === 'pinch') {
      const mid = this.midpoint();
      const dist = this.pointerDistance();
      if (!mid || dist <= 0 || this.drag.startDist <= 0) return;
      this.setPointer(mid);
      const local = this.localOnFace(this.drag.frame, this.drag.plane);
      if (!local) return;
      const { frame, start, startLocal } = this.drag;
      const scale = Math.min(8, Math.max(1, start.scale * (dist / this.drag.startDist)));
      const k = scale / start.scale;
      const au = startLocal.u / frame.width;
      const av = startLocal.v / frame.height;
      const panU = (local.u - startLocal.u) / frame.width;
      const panV = (local.v - startLocal.v) / frame.height;
      this.applyTransform(
        this.drag.face,
        {
          ...start,
          scale,
          offsetX: au - (au - start.offsetX) * k + panU,
          offsetY: av - (av - start.offsetY) * k + panV,
        },
        false,
      );
      return;
    }

    if (this.pointers.size === 0) {
      const hit = this.faceAtClient(e.clientX, e.clientY);
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.refreshOutline();
        const st = this.state;
        const grabbable = hit !== null && hit === st.selected && st.faces[hit].source !== null;
        this.renderer.domElement.style.cursor = grabbable ? 'grab' : hit !== null ? 'pointer' : 'move';
      }
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    }
    if (this.drag.kind === 'none') return;

    if (this.pointers.size === 0) {
      const drag = this.drag;
      this.drag = { kind: 'none' };
      this.renderer.domElement.style.cursor = 'grab';
      if (drag.kind === 'pan' || drag.kind === 'pinch') {
        this.cb.onTransform(drag.face, this.currentTransform(drag.face), true);
      }
      return;
    }

    // 松开一根手指，退回单指平移
    if (this.drag.kind === 'pinch' && this.pointers.size === 1) {
      const remaining = [...this.pointers.values()][0];
      this.beginTexturePan(this.drag.face, { clientX: remaining.x, clientY: remaining.y });
    }
  };

  private onPointerLeave = () => {
    if (this.drag.kind === 'none' && this.hovered !== null) {
      this.hovered = null;
      this.refreshOutline();
    }
  };

  private onWheel = (e: WheelEvent) => {
    const st = this.state;
    if (!st || st.selected === null) return;
    const sel = st.selected;
    if (st.faces[sel].source === null) return;
    const hit = this.faceAtClient(e.clientX, e.clientY);
    if (hit !== sel) return; // 相机是固定的，不在选中面上滚就什么都不做

    e.preventDefault();
    e.stopPropagation();

    const frame = this.worldFrame(sel);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.center);
    const local = this.localOnFace(frame, plane);
    if (!local) return;
    const t = this.currentTransform(sel);
    const scale = Math.min(8, Math.max(1, t.scale * Math.exp(-e.deltaY * 0.0016)));
    const k = scale / t.scale;
    // 以光标所在位置为锚点缩放（Figma / 地图那套肌肉记忆），不是以面心
    const au = local.u / frame.width;
    const av = local.v / frame.height;
    this.applyTransform(
      sel,
      { ...t, scale, offsetX: au - (au - t.offsetX) * k, offsetY: av - (av - t.offsetY) * k },
      true,
    );
  };
}

function makeOutline(color: number, thicknessRatio: number): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3));
  const index: number[] = [];
  for (let i = 0; i < 4; i++) {
    index.push(i, (i + 1) % 4, 4 + ((i + 1) % 4), i, 4 + ((i + 1) % 4), 4 + i);
  }
  g.setIndex(index);
  const m = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 10;
  mesh.userData.thicknessRatio = thicknessRatio;
  return mesh;
}

/** 描边做成一圈薄环 mesh，而不是 LineSegments —— WebGL 里 linewidth 是被忽略的，1px 太容易看漏 */
function setOutline(outline: THREE.Mesh, frame: FaceFrame) {
  const { center, normal, u, v, width, height } = frame;
  const hw = width / 2;
  const hh = height / 2;
  const th = Math.min(width, height) * (outline.userData.thicknessRatio as number);
  const off = normal.clone().multiplyScalar(Math.max(width, height) * 0.004 + 0.0002);
  const base = center.clone().add(off);
  const corner = (su: number, sv: number, inset: number) =>
    base
      .clone()
      .add(u.clone().multiplyScalar(su * Math.max(0, hw - inset)))
      .add(v.clone().multiplyScalar(sv * Math.max(0, hh - inset)));
  const pts = [
    corner(-1, -1, 0),
    corner(1, -1, 0),
    corner(1, 1, 0),
    corner(-1, 1, 0),
    corner(-1, -1, th),
    corner(1, -1, th),
    corner(1, 1, th),
    corner(-1, 1, th),
  ];
  const arr: number[] = [];
  for (const p of pts) arr.push(p.x, p.y, p.z);
  const attr = outline.geometry.getAttribute('position') as THREE.BufferAttribute;
  attr.set(new Float32Array(arr));
  attr.needsUpdate = true;
  outline.geometry.computeBoundingSphere();
}
