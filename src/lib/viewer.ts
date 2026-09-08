import * as THREE from 'three';
import { applyLift, makeCapMaterial, makeFaceMaterial } from './material';
import { capGeometry, cardGeometry, faceCenterAngle, faceFrame, sideGeometry, type FaceFrame } from './geometry';
import { compensateToLinear, srgbToLinear } from './color';

function hexToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}
import type { FaceTextureStore } from './faceTexture';
import { CAP_LEFT, CAP_RIGHT, CARD_BACK, CARD_FRONT, MAX_SIDES, innerSlot, isCap, isCardEdge, sectionOf, type FaceState, type FaceTransform, type Params } from './types';

type ViewerState = { params: Params; faces: FaceState[]; selected: number | null };

export type ViewerCallbacks = {
  onSelect: (index: number | null) => void;
  onTransform: (index: number, t: FaceTransform, commit: boolean) => void;
};

/**
 * 视口里只有一种拖拽：转模型。
 * 「在面上拖动里面那张图」那套整个删掉了 —— 想转模型结果图跟着窜，太难用。
 * 挪图去右侧栏的预览框里做。
 */
type Drag = { kind: 'none' } | { kind: 'rotate'; lastX: number; lastY: number };

const TAU = Math.PI * 2;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const Q_A = new THREE.Quaternion();
const Q_B = new THREE.Quaternion();

/** 把 target 折算成离 current 最近的等价角度，避免转最长的那条路 */
function shortestTo(current: number, target: number): number {
  const d = (((target - current) % TAU) + TAU + Math.PI) % TAU - Math.PI;
  return current + d;
}

// 默认就正对第 0 面 —— 和导出时归零的姿态一致，
// 免得视口里是斜的、进了 Keynote 又是正的，两头对不上。
const DEFAULT_YAW = 0;
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
  private sideMaterials: THREE.MeshPhysicalMaterial[] = [];
  private innerMaterials: THREE.MeshPhysicalMaterial[] = [];
  private innerMeshes: THREE.Mesh[] = [];
  private capRight: THREE.Mesh;
  private capLeft: THREE.Mesh;
  private capRightMat: THREE.MeshPhysicalMaterial;
  private capLeftMat: THREE.MeshPhysicalMaterial;
  private outline: THREE.Mesh;
  private hoverline: THREE.Mesh;

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
  private paused = false;
  /** 视口缩放：双指上下推拉远拉近，1 = 刚好占满 */
  private zoom = 1;
  private ro: ResizeObserver;

  constructor(container: HTMLElement, store: FaceTextureStore, cb: ViewerCallbacks) {
    this.container = container;
    this.store = store;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    // 范式：工作区是白底。视口只是「看」的地方，导出的模型不含背景。
    this.renderer.setClearColor(0xffffff, 1);
    this.syncBackground();
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

    this.scene.add(this.pivot);
    this.pivot.add(this.prism);

    // 材质参数全部来自 lib/material —— 色卡棱柱用的是同一份，不能在这里另写一套
    this.capRightMat = makeCapMaterial(0xd9d9de);
    this.capLeftMat = makeCapMaterial(0xd9d9de);
    this.capRightMat.name = 'cap_right';
    this.capLeftMat.name = 'cap_left';
    this.capRight = new THREE.Mesh(new THREE.BufferGeometry(), this.capRightMat);
    this.capLeft = new THREE.Mesh(new THREE.BufferGeometry(), this.capLeftMat);
    this.capRight.name = 'cap_right';
    this.capLeft.name = 'cap_left';
    this.capRight.userData.faceIndex = CAP_RIGHT;
    this.capLeft.userData.faceIndex = CAP_LEFT;
    this.prism.add(this.capRight, this.capLeft);

    for (let i = 0; i < MAX_SIDES; i++) {
      const mat = makeFaceMaterial(store.textures[i]);
      mat.name = `face_${i}`;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.name = `face_${i}`;
      mesh.userData.faceIndex = i;

      // 同一个面的内面：法线朝里，挂它自己那张贴图。
      // 正反两面各贴一张图（像卡片），所以必须是两个 mesh 两个材质 ——
      // USD 的 doubleSided 只能让同一张图两面都看得见，做不到正反不同。
      const innerMat = makeFaceMaterial(store.textures[innerSlot(i)]);
      innerMat.name = `face_${i}_inner`;
      const innerMesh = new THREE.Mesh(new THREE.BufferGeometry(), innerMat);
      innerMesh.name = `face_${i}_inner`;
      innerMesh.userData.faceIndex = innerSlot(i);
      this.innerMaterials[i] = innerMat;
      this.innerMeshes[i] = innerMesh;
      this.prism.add(innerMesh);
      mesh.visible = false;
      this.sideMaterials.push(mat);
      this.sideMeshes.push(mesh);
      this.prism.add(mesh);
    }

    // 选中不再画任何标记 —— 从 dock 选面会直接把那一面转到正对镜头，本身就说明了「选的是它」。
    // 只留一圈极淡的悬停描边，指哪个面时给点提示。
    this.outline = makeOutline(0x1d1d1f, 0.0);
    this.hoverline = makeOutline(0x86868b, 0.012);
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

  /**
   * 暂停/恢复渲染。
   *
   * 导出时要把「补偿后」的像素烘进贴图，而那批像素本来就比看到的暗一截 ——
   * 一边烘一边渲染，预览就会先整个变暗、导完再变回来，看着像卡死了。
   * 停掉渲染，画布会一直停在最后那一帧，用户完全看不到中间态。
   */
  /**
   * 视口底色跟着界面主题走。
   * 从 CSS 变量读，不在这里再写一份颜色 —— 两处各写一份迟早会走散。
   */
  syncBackground() {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    if (!css) return;
    try {
      this.renderer.setClearColor(new THREE.Color(css), 1);
    } catch {
      /* 变量还没就位就先不管，下一次主题切换会再来一遍 */
    }
  }

  setPaused(v: boolean) {
    this.paused = v;
  }

  /**
   * 把当前这一帧拍成图片。
   *
   * 必须先 render 再立刻读 —— 这块画布没开 preserveDrawingBuffer，
   * 隔一个任务再读就是空白（之前踩过这个坑）。
   */
  snapshot(): string | null {
    try {
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
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

  update(next: ViewerState) {
    // faces 复制一份：拖拽时视口会就地改自己这份，不去动 React 的状态对象
    this.state = { ...next, faces: next.faces.slice() };
    const { params } = next;
    const sig = `${params.modelType}|${params.sides}|${params.radius}|${params.length}|${params.aspect}|${params.thickness}|${params.corner}|${params.capMode}`;
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
      if (isCardEdge(params, i)) {
        // 卡片的窄边：纯色。默认跟着正面贴图的平均色走 —— 红卡片的侧边不该是灰的
        this.paintSolid(m, this.edgeColor(), this.exportMode);
      } else {
        // 补光 > 0 时也要挂 emissiveMap，加法那一项才能逐像素跟着贴图走
        applyLift(m, this.store.textures[i], lift, unlit);
      }

      applyLift(this.innerMaterials[i], this.store.textures[innerSlot(i)], lift, unlit);
    }
    // 「没有端面」就是把两头的盖子藏掉 —— 隐藏的对象不会被写进 usdz
    // （导出器走的是 traverseVisible，visible = false 的 mesh 根本不会被遍历到）
    const showCaps = params.modelType === 'prism' && params.capMode !== 'none';
    this.capRight.visible = showCaps && !next.faces[CAP_RIGHT]?.hidden;
    this.capLeft.visible = showCaps && !next.faces[CAP_LEFT]?.hidden;
    this.applyHidden();
    this.applyCapColors(false);

    this.refreshOutline();
  }

  /**
   * 逐面的「不显示」开关。
   *
   * 藏掉一个面之后，从那一侧看过去就是空的、能看穿到里面 —— 这是 USD 单面渲染的
   * 自然结果，不是透明。导出时同样有效：USDZExporter 走 traverseVisible，
   * visible = false 的 mesh 连写都不会写进文件。
   *
   * 只在几何本来就该出现的面上生效：几何重建那边已经把不该有的面藏好了，
   * 这里只做「再藏一层」，绝不会把藏好的又打开。
   */
  private applyHidden() {
    const st = this.state!;
    const p = st.params;
    const card = p.modelType === 'card';
    // 卡片用到 0（正面）/ 1（一圈侧边）/ 2（背面）三个 mesh
    const used = card ? 3 : p.sides;
    const withInner = !card && p.capMode === 'none';
    for (let i = 0; i < MAX_SIDES; i++) {
      // 卡片那一圈侧边没有对应的 dock 格子，也就没有开关，别被别的模式留下的标记误伤
      const off = card && i === 1 ? false : !!st.faces[i]?.hidden;
      // **两个方向都要写。**只写 false 的话，取消勾选之后没人把它打开 ——
      // 只有几何重建才会恢复，而改这个开关不会触发重建，面就再也回不来了。
      this.sideMeshes[i].visible = i < used && !off;
      this.innerMeshes[i].visible = withInner && i < p.sides && !st.faces[innerSlot(i)]?.hidden;
    }
  }

  private rebuildGeometry() {
    const p = this.state!.params;
    const { length } = p;
    if (p.modelType === 'card') {
      this.rebuildCard();
      return;
    }
    const sec = sectionOf(p);
    const sides = sec.sides;
    // 「没有端面」时才需要内面：封了口本来就看不到里面。卡片永远是实心的，没有内面。
    const showInner = p.modelType === 'prism' && p.capMode === 'none';
    for (let i = 0; i < MAX_SIDES; i++) {
      const inner = this.innerMeshes[i];
      inner.geometry.dispose();
      if (i < sides && showInner) {
        inner.geometry = sideGeometry(i, sec, length, 'inner');
        inner.visible = true;
      } else {
        inner.geometry = new THREE.BufferGeometry();
        inner.visible = false;
      }
      // 卡片的四条窄边不发贴图，走纯色 —— 一张 2K 纯色 PNG 一百多 KB，四条边纯浪费。
      // 这一步放在几何重建里做，不能放进 syncSideMaterials：导出时会把 map 换成
      // 一批全新的 texture 对象，那会儿再动 map 就把替换给冲掉了。
      const wantMap = isCardEdge(p, i) ? null : this.store.textures[i];
      if (this.sideMaterials[i].map !== wantMap) {
        this.sideMaterials[i].map = wantMap;
        this.sideMaterials[i].needsUpdate = true;
      }
      const mesh = this.sideMeshes[i];
      mesh.geometry.dispose();
      if (i < sides) {
        mesh.geometry = sideGeometry(i, sec, length);
        mesh.visible = true;
      } else {
        mesh.geometry = new THREE.BufferGeometry();
        mesh.visible = false;
      }
    }
    this.capRight.geometry.dispose();
    this.capLeft.geometry.dispose();
    this.capRight.geometry = capGeometry(sec, length, true);
    this.capLeft.geometry = capGeometry(sec, length, false);
  }

  /**
   * 卡片：圆角矩形沿厚度拉出来，三块几何挂到三个现成的 mesh 上 ——
   * 正面 → face 0、背面 → face 2（和 CARD_FRONT / CARD_BACK 对得上），
   * 一圈侧边 → face 1。face 3 和两个端面藏起来。
   * 这样 dock、槽位、拾取全都不用为卡片开特例。
   */
  private rebuildCard() {
    const p = this.state!.params;
    const height = p.length / p.aspect;
    const { front, back, band } = cardGeometry(p.length, height, p.thickness, p.corner);
    const put = (i: number, g: THREE.BufferGeometry | null) => {
      const mesh = this.sideMeshes[i];
      mesh.geometry.dispose();
      mesh.geometry = g ?? new THREE.BufferGeometry();
      mesh.visible = g !== null;
      const inner = this.innerMeshes[i];
      inner.geometry.dispose();
      inner.geometry = new THREE.BufferGeometry();
      inner.visible = false;
      const wantMap = isCardEdge(p, i) ? null : this.store.textures[i];
      if (this.sideMaterials[i].map !== wantMap) {
        this.sideMaterials[i].map = wantMap;
        this.sideMaterials[i].needsUpdate = true;
      }
    };
    put(CARD_FRONT, front);
    put(1, band);
    put(CARD_BACK, back);
    for (let i = 3; i < MAX_SIDES; i++) put(i, null);
    // 卡片是一整块，没有端面这回事
    this.capRight.visible = false;
    this.capLeft.visible = false;
  }

  /** 相机方向永远固定在 +Z，只按包围球调距离，保证物体始终占满画面 */
  fitCamera() {
    const p = this.state!.params;
    // 卡片的外接半径按它自己的宽高厚算，别拿棱柱那个外接圆半径
    const r =
      p.modelType === 'card'
        ? Math.hypot(p.length / 2, p.length / p.aspect / 2, p.thickness / 2)
        : Math.hypot(p.length / 2, p.radius);
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 1.22 * this.zoom;
    this.camera.position.set(0, 0, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.001, dist - r * 2);
    this.camera.far = dist + r * 6;
    this.camera.updateProjectionMatrix();
  }

  resetRotation() {
    this.yaw = shortestTo(this.yaw, DEFAULT_YAW);
    this.spin = shortestTo(this.spin, DEFAULT_SPIN);
    this.zoom = 1;
    this.fitCamera();
  }

  /** 把某个侧面转到正对相机，贴图定位时最好用 */
  faceOn(index: number) {
    const st = this.state;
    if (!st) return;
    if (st.params.modelType === 'card') {
      // 卡片像翻书一样左右翻，不是上下翻 —— 背面的贴图就是按这个方向贴的
      this.yaw = shortestTo(this.yaw, index === CARD_BACK ? Math.PI : 0);
      this.spin = shortestTo(this.spin, 0);
      return;
    }
    if (isCap(index)) {
      // 端面朝 ±X，把棱柱绕 Y 转四分之一圈才正对相机
      this.yaw = shortestTo(this.yaw, index === CAP_RIGHT ? -Math.PI / 2 : Math.PI / 2);
      this.spin = shortestTo(this.spin, 0);
      return;
    }
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

  /**
   * 端面：贴了图就走贴图那一路（和侧面同样的规则），没贴图还是纯色。
   * 纯色不受 8 位限制，可以直接写 > 1 的线性值，不需要贴图那套增益。
   */
  /**
   * 给一个「没有贴图」的面上色：端面、以及卡片的四条窄边。
   * 纯色不受 8 位限制，可以直接写 > 1 的线性值，不需要贴图那套增益。
   */
  /** 卡片侧边的颜色：默认取正面贴图的平均色，用户手动调过就用他调的 */
  private edgeColor(): string {
    const p = this.state!.params;
    return p.edgeAuto ? this.store.averageColor(CARD_FRONT) : p.capColorRight;
  }

  private paintSolid(mat: THREE.MeshPhysicalMaterial, hex: string, compensate: boolean) {
    const p = this.state!.params;
    const unlit = p.emissiveExport;
    const lift = this.liftNow();
    if (mat.emissiveMap) {
      mat.emissiveMap = null;
      mat.needsUpdate = true;
    }
    const lin = compensate ? compensateToLinear(hex, p.color) : null;
    const raw: [number, number, number] = lin ?? hexToLinear(hex);
    const base = raw;
    mat.color.setRGB(unlit ? 0 : base[0], unlit ? 0 : base[1], unlit ? 0 : base[2]);
    mat.emissive.setRGB(lift * base[0], lift * base[1], lift * base[2]);
  }

  private applyCapColors(compensate: boolean) {
    const p = this.state!.params;
    const st = this.state!;
    const withCaps = p.capMode !== 'none' && p.separateCaps;
    const raw: [THREE.MeshPhysicalMaterial, string, number][] = [
      [this.capRightMat, p.capColorRight, CAP_RIGHT],
      [this.capLeftMat, p.separateCaps ? p.capColorLeft : p.capColorRight, CAP_LEFT],
    ];
    const unlit = p.emissiveExport;
    const lift = this.liftNow();
    for (const [mat, hex, slot] of raw) {
      const textured = withCaps && !!st.faces[slot]?.source;
      const wantMap = textured ? this.store.textures[slot] : null;
      if (mat.map !== wantMap) {
        mat.map = wantMap;
        mat.needsUpdate = true;
      }
      if (textured) {
        // 和侧面完全一样：补偿已经烘进贴图里了，材质本身保持中性
        const want = lift > 0 ? mat.map : null;
        if (mat.emissiveMap !== want) {
          mat.emissiveMap = want;
          mat.needsUpdate = true;
        }
        mat.emissive.setRGB(lift, lift, lift);
        mat.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
        continue;
      }
      this.paintSolid(mat, hex, compensate);
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
      if (isCardEdge(p, i)) {
        this.paintSolid(m, this.edgeColor(), this.exportMode);
      } else {
        const want = lift > 0 ? m.map ?? this.store.textures[i] : null;
        if (m.emissiveMap !== want) {
          m.emissiveMap = want;
          m.needsUpdate = true;
        }
        m.emissive.setRGB(lift, lift, lift);
        m.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
      }

      const im = this.innerMaterials[i];
      const wantInner = lift > 0 ? im.map ?? this.store.textures[innerSlot(i)] : null;
      if (im.emissiveMap !== wantInner) {
        im.emissiveMap = wantInner;
        im.needsUpdate = true;
      }
      im.emissive.setRGB(lift, lift, lift);
      im.color.setRGB(unlit ? 0 : 1, unlit ? 0 : 1, unlit ? 0 : 1);
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
    const { sides, length } = st.params;
    const sel = st.selected;
    // 选中态不画东西了
    this.outline.visible = false;
    void sel;
    if (this.hovered === null || this.hovered >= sides || this.hovered === sel) {
      this.hoverline.visible = false;
    } else {
      setOutline(this.hoverline, faceFrame(this.hovered, sectionOf(st.params), length));
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

  // ---- 交互 ----

  private onPointerDown = (e: PointerEvent) => {
    if (!this.state) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // **视口里的鼠标只做一件事：转模型。**
    // 从前在选中面上按下会变成「拖里面那张图」—— 想转一下模型，图却跟着窜，
    // 非常难用。挪图和缩放一律去右侧栏的预览框里做，这里绝不再抢这个手势。
    const hit = this.faceAtClient(e.clientX, e.clientY);
    const st = this.state;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (hit !== null && hit !== st.selected) this.cb.onSelect(hit);
    this.drag = { kind: 'rotate', lastX: e.clientX, lastY: e.clientY };
    this.renderer.domElement.style.cursor = 'grabbing';
  };

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
      // 饼饼给的判据（照着截图定的，别再改）：顶上是绿面、正面是红面时，
      // 往下拖 → 绿面转下来正对镜头；往上拖 → 红面转回来正对镜头。
      // 也就是「哪一面在手指底下，它就跟着手指走」。
      this.spin += dy * 0.0075;
      return;
    }

    if (this.pointers.size === 0) {
      const hit = this.faceAtClient(e.clientX, e.clientY);
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.refreshOutline();
        this.renderer.domElement.style.cursor = hit !== null ? 'pointer' : 'move';
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
      this.drag = { kind: 'none' };
      this.renderer.domElement.style.cursor = 'grab';
    }
  };

  private onPointerLeave = () => {
    if (this.drag.kind === 'none' && this.hovered !== null) {
      this.hovered = null;
      this.refreshOutline();
    }
  };

  /**
   * 双指上下推 = 把模型拉近拉远。
   *
   * 从前这里是「缩放选中面上的贴图」—— 但贴图缩放右边有滑块，
   * 而视口里没有别的办法拉近看细节，滚轮给视口更合理。
   */
  private onWheel = (e: WheelEvent) => {
    if (!this.state) return;
    e.preventDefault();
    e.stopPropagation();
    // 触控板给的 deltaY 很碎，用指数缩放才跟手；夹在 0.35~4 倍之间
    this.zoom = Math.min(4, Math.max(0.35, this.zoom * Math.exp(e.deltaY * 0.0016)));
    this.fitCamera();
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
