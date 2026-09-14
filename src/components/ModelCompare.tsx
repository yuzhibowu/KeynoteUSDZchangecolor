import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { applyForwardToImageData, type ColorComp } from '../lib/color';
import { normalizeUsdzForLoader } from '../lib/recolor';
import { frameCamera, loadUsdz, makeScene } from '../lib/usdzScene';

/**
 * 校正前 / 校正后的**模型**对比。
 *
 * 两个视口共用同一个旋转，自己慢慢转（像转台那样），拖动可以手动转。
 * 两边渲染的都是「放进 Keynote 之后的样子」—— 也就是把正向模型套在贴图上，
 * 而不是文件本身的样子。左边是不校正的结果（你现在遇到的偏色），
 * 右边是校正后的结果（应该和你的原图一致）。
 *
 * 用的是 three 自带的 USDZLoader，它和我们的校正管线边界一样：
 * 只认文本 usda，遇到二进制 usdc 会直接抛错 —— 那种情况退回图片对比。
 */

/** 预览用的贴图最长边。原图可能是 4K，逐像素跑一遍没必要 */
const PREVIEW_TEX = 1024;

/** 把模型上每张贴图换成「Keynote 里会显示成的样子」 */
function simulate(root: THREE.Object3D, comp: ColorComp) {
  const done = new Map<THREE.Texture, THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!mat.map?.image) continue;
      const hit = done.get(mat.map);
      if (hit) {
        mat.map = hit;
        continue;
      }
      const src = mat.map.image as HTMLImageElement | ImageBitmap;
      const w = (src as HTMLImageElement).naturalWidth || (src as HTMLImageElement).width;
      const h = (src as HTMLImageElement).naturalHeight || (src as HTMLImageElement).height;
      // 还没解码好就别动它 —— 宁可显示原色，也不能换成一张 1×1 的空图
      if (!w || !h) continue;
      const k = Math.min(1, PREVIEW_TEX / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(src as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      applyForwardToImageData(img.data, comp);
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = mat.map.colorSpace;
      tex.wrapS = mat.map.wrapS;
      tex.wrapT = mat.map.wrapT;
      tex.repeat.copy(mat.map.repeat);
      tex.offset.copy(mat.map.offset);
      tex.flipY = mat.map.flipY;
      tex.needsUpdate = true;
      done.set(mat.map, tex);
      mat.map = tex;
      mat.needsUpdate = true;
    }
  });
}

export function ModelCompare({
  original,
  corrected,
  comp,
  spin,
  onReady,
  onUnsupported,
}: {
  original: ArrayBuffer;
  corrected: Uint8Array;
  comp: ColorComp;
  /** 自动旋转开关。由外面那个按钮控制 —— 拖动不该顺手把它关掉 */
  spin: boolean;
  onReady: (ready: boolean) => void;
  onUnsupported: (why: string) => void;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) return;
    let alive = true;
    let raf = 0;
    let cleanup: (() => void) | null = null;
    const parts: ReturnType<typeof makeScene>[] = [];

    (async () => {
      let a: THREE.Object3D;
      let b: THREE.Object3D;
      try {
        // 加载器会改传进去的 buffer 吗？不确定，各给一份拷贝更保险
        // 排版规范化之后再喂给加载器 —— 有些导出器写的 usda 是紧凑格式，
        // 而这个解析器按行切，紧凑格式会让它一个 mesh 都认不出来
        a = await loadUsdz(normalizeUsdzForLoader(original.slice(0)));
        b = await loadUsdz(normalizeUsdzForLoader(corrected.slice().buffer as ArrayBuffer));
      } catch (e) {
        onUnsupported(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!alive) return;

      // 左边：不校正，直接拿原模型去显示 → 就是现在的偏色
      simulate(a, comp);
      // 右边：校正后的模型再走同一遍显示 → 应该回到原图的颜色
      simulate(b, comp);

      const box = new THREE.Box3().setFromObject(a);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(1e-4, size.length() / 2);

      for (const [host, obj] of [
        [l, a],
        [r, b],
      ] as [HTMLDivElement, THREE.Object3D][]) {
        const part = makeScene(host);
        obj.position.sub(center);
        part.pivot.add(obj);
        parts.push(part);
      }

      const resize = () => {
        for (const p of parts) {
          const host = p.renderer.domElement.parentElement!;
          const w = host.clientWidth || 1;
          const h = host.clientHeight || 1;
          p.renderer.setSize(w, h);
          p.camera.aspect = w / h;
          frameCamera(p.camera, radius);
        }
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(l);
      onReady(true);

      let yaw = 0.35;
      let pitch = 0.18;
      let last = performance.now();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        if (spinRef.current) yaw += dt * 0.5;
        for (const p of parts) {
          p.pivot.rotation.set(pitch, yaw, 0);
          p.renderer.render(p.scene, p.camera);
        }
      };
      loop();

      // 在任意一边拖动，两边一起转
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const down = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        // **别在这里关掉自动旋转。**拖一下就停，是把两件事绑在了一起；
        // 想停就按那个按钮，拖动只管加角度。
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!dragging) return;
        yaw += (e.clientX - lastX) * 0.01;
        // 上下也能转。方向和主视口一致：往下拖，正对着你的那一面就往下走。
        // 夹在 ±80° 以内，别让它翻过顶点，那一下会很晕
        pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - lastY) * 0.01));
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const up = () => {
        dragging = false;
      };
      for (const host of [l, r]) {
        host.addEventListener('pointerdown', down);
        host.addEventListener('pointermove', move);
        host.addEventListener('pointerup', up);
        host.addEventListener('pointercancel', up);
      }

      cleanup = () => {
        ro.disconnect();
        for (const host of [l, r]) {
          host.removeEventListener('pointerdown', down);
          host.removeEventListener('pointermove', move);
          host.removeEventListener('pointerup', up);
          host.removeEventListener('pointercancel', up);
        }
      };
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      cleanup?.();
      for (const p of parts) {
        p.renderer.dispose();
        p.renderer.domElement.remove();
      }
    };
  }, [original, corrected, comp, onUnsupported]);

  const spinRef = useRef(true);
  spinRef.current = spin;

  return (
    <div className="model-compare">
      <div className="compare-pair">
        <figure>
          <div ref={leftRef} className="mc-view" />
          <figcaption>校正前</figcaption>
        </figure>
        <figure>
          <div ref={rightRef} className="mc-view" />
          <figcaption>校正后</figcaption>
        </figure>
      </div>
    </div>
  );
}
