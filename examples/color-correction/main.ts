import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import {
  applyToImageData, createCorrectionPreset, type CorrectionPresetId,
} from '../../src/color-correction';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const select = document.querySelector<HTMLSelectElement>('#preset')!;
const source = document.createElement('canvas');
source.width = 512;
source.height = 384;
const ctx = source.getContext('2d')!;
const colors = ['#000000', '#ffffff', '#a11400', '#c87850', '#00a0ff', '#fdbE2e', '#aa70bb', '#80c0a0'];
for (let i = 0; i < colors.length; i++) {
  ctx.fillStyle = colors[i];
  ctx.fillRect((i % 4) * 128, Math.floor(i / 4) * 96, 128, 96);
}
const gradient = ctx.createLinearGradient(0, 192, 512, 384);
gradient.addColorStop(0, '#102030');
gradient.addColorStop(0.4, '#c87850');
gradient.addColorStop(0.7, '#90b4dc');
gradient.addColorStop(1, '#ffffff');
ctx.fillStyle = gradient;
ctx.fillRect(0, 192, 512, 192);

function texture(corrected: boolean, id: CorrectionPresetId) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(source, 0, 0);
  if (corrected) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    applyToImageData(pixels.data, createCorrectionPreset(id).comp);
    context.putImageData(pixels, 0, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function model(corrected: boolean, id: CorrectionPresetId) {
  const { conditions } = createCorrectionPreset(id);
  const tex = texture(corrected, id);
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex, roughness: conditions.roughness, metalness: conditions.metalness,
    clearcoat: conditions.clearcoat, opacity: conditions.opacity,
  });
  mat.emissiveMap = conditions.lift > 0 ? tex : null;
  mat.emissive.setRGB(conditions.lift, conditions.lift, conditions.lift);
  const group = new THREE.Group();
  if (conditions.shape === 'card') {
    // 独立的六个单材质面，避免 USDZExporter 的数组材质限制。
    const w = 0.12, h = 0.09, d = 0.006;
    const face = (width: number, height: number, position: number[], rotation: number[]) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
      group.add(mesh);
    };
    face(w, h, [0,0,d/2], [0,0,0]);
    face(w, h, [0,0,-d/2], [0,Math.PI,0]);
    face(d, h, [w/2,0,0], [0,Math.PI/2,0]);
    face(d, h, [-w/2,0,0], [0,-Math.PI/2,0]);
    face(w, d, [0,h/2,0], [-Math.PI/2,0,0]);
    face(w, d, [0,-h/2,0], [Math.PI/2,0,0]);
  } else {
    const sides = 6, radius = 0.045, length = 0.12;
    const points = Array.from({ length: sides }, (_, i) => {
      const a = (i - 0.5) * Math.PI * 2 / sides;
      return [Math.sin(a) * radius, Math.cos(a) * radius];
    });
    for (let i = 0; i < sides; i++) {
      const [y0,z0] = points[i], [y1,z1] = points[(i+1)%sides];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        -length/2,y0,z0, length/2,y0,z0, length/2,y1,z1, -length/2,y1,z1,
      ],3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));
      geometry.setIndex([0,1,2,0,2,3]);
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry, mat));
    }
  }
  group.updateMatrixWorld(true);
  return { group, dispose() {
    group.children.forEach(o => (o as THREE.Mesh).geometry.dispose());
    tex.dispose(); mat.dispose();
  } };
}

const views = ['raw', 'corrected'].map(id => {
  const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector<HTMLCanvasElement>('#'+id)!, antialias: true });
  renderer.setSize(440, 340, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e1e0d9');
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(1,2,3);
  scene.add(light, new THREE.AmbientLight(0xffffff, 1));
  const camera = new THREE.PerspectiveCamera(35, 440/340, 0.01, 10);
  camera.position.set(0.03,0.02,0.26);
  camera.lookAt(0,0,0);
  return { renderer, scene, camera, current: null as ReturnType<typeof model> | null };
});

function refresh() {
  const id = select.value as CorrectionPresetId;
  status.textContent = '准备模型…';
  // 首次建表需要时间；让状态文字先绘制。
  setTimeout(() => {
    views.forEach((view,i) => {
      if (view.current) { view.scene.remove(view.current.group); view.current.dispose(); }
      view.current = model(i===1,id);
      view.scene.add(view.current.group);
      view.renderer.render(view.scene,view.camera);
    });
    status.textContent = '模型已就绪。请下载两份文件在目标应用对照。';
  }, 0);
}

async function exportModel(corrected: boolean) {
  status.textContent = '正在导出…';
  let current: ReturnType<typeof model> | undefined;
  try {
    const id = select.value as CorrectionPresetId;
    current = model(corrected,id);
    const bytes = await new USDZExporter().parseAsync(current.group, {
      maxTextureSize: 512, includeAnchoringProperties: true, quickLookCompatible: false,
    });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type:'model/vnd.usdz+zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}-${corrected?'corrected':'raw'}.usdz`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    status.textContent = `已导出${corrected?'补偿':'未补偿'} USDZ。`;
  } catch (error) {
    status.textContent = `导出失败：${String(error)}`;
  } finally { current?.dispose(); }
}
select.addEventListener('change',refresh);
document.querySelector('#raw-export')!.addEventListener('click',()=>void exportModel(false));
document.querySelector('#corrected-export')!.addEventListener('click',()=>void exportModel(true));
refresh();
