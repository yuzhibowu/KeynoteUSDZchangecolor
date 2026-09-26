import { describe, expect, it } from 'vitest';
import { cardGeometry } from './geometry';
import { outlineFromAlpha } from './cardOutline';
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { unzipSync } from 'fflate';

function alpha(w: number, h: number, inside: (x: number, y: number) => boolean) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inside(x, y)) rgba[(y * w + x) * 4 + 3] = 255;
  }
  return rgba;
}

function surfaceArea(geometry: ReturnType<typeof cardGeometry>['front']) {
  const position = geometry.getAttribute('position');
  const triangles = geometry.getIndex()!;
  let sum = 0;
  for (let i = 0; i < triangles.count; i += 3) {
    const a = triangles.getX(i), b = triangles.getX(i + 1), c = triangles.getX(i + 2);
    sum += Math.abs((position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
      (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a))) / 2;
  }
  return sum;
}

describe('适应模式的 PNG 卡片轮廓', () => {
  it('不透明正面仍是普通矩形', () => {
    expect(outlineFromAlpha(alpha(20, 12, () => true), 20, 12)).toBeNull();
  });

  it('凹角决定正反面和侧边的真实形状', () => {
    const w = 32, h = 32;
    const outline = outlineFromAlpha(alpha(w, h, (x, y) => x < 24 && y < 24 && !(x >= 12 && y < 12)), w, h)!;
    expect(outline).toHaveLength(1);
    expect(outline[0].holes).toHaveLength(0);
    const { front, back, band } = cardGeometry(1, 1, 0.1, 0, outline);
    expect(surfaceArea(front)).toBeCloseTo(0.421875, 4); // (24² - 12²) / 32²
    expect(surfaceArea(back)).toBeCloseTo(surfaceArea(front), 6);
    expect(band.getIndex()!.count).toBeGreaterThan(24);
    const fu = front.getAttribute('uv');
    const bu = back.getAttribute('uv');
    for (let i = 0; i < fu.count; i++) {
      expect(bu.getX(i)).toBeCloseTo(1 - fu.getX(i), 6);
      expect(bu.getY(i)).toBeCloseTo(fu.getY(i), 6);
    }
  });

  it('正面透明洞会穿透背面，并生成洞内侧壁', () => {
    const outline = outlineFromAlpha(alpha(32, 32, (x, y) => !(x >= 10 && x < 22 && y >= 10 && y < 22)), 32, 32)!;
    expect(outline).toHaveLength(1);
    expect(outline[0].holes).toHaveLength(1);
    const { front, back, band } = cardGeometry(1, 1, 0.1, 0, outline);
    expect(surfaceArea(front)).toBeCloseTo(1 - 12 * 12 / 32 / 32, 5);
    expect(surfaceArea(back)).toBeCloseTo(surfaceArea(front), 6);
    expect(band.getIndex()!.count).toBeGreaterThanOrEqual(48); // 外圈和内洞均有侧壁
  });

  it('分开的明显图案都保留，小孤点过滤', () => {
    const outline = outlineFromAlpha(alpha(40, 20, (x, y) =>
      (x >= 2 && x < 12 && y >= 3 && y < 17) ||
      (x >= 25 && x < 35 && y >= 3 && y < 17) ||
      (x === 39 && y === 19)), 40, 20)!;
    expect(outline).toHaveLength(2);
    expect(surfaceArea(cardGeometry(1, 0.5, 0.05, 0, outline).front)).toBeCloseTo(280 / 800 * 0.5, 6);
  });

  it('凹口和洞的三块几何可以写入 USDZ', async () => {
    const outline = outlineFromAlpha(alpha(32, 32, (x, y) =>
      !(x >= 10 && x < 22 && y >= 10 && y < 22) && !(x >= 24 && y < 8)), 32, 32)!;
    const parts = cardGeometry(1, 1, 0.1, 0, outline);
    const group = new THREE.Group();
    for (const [name, geometry] of Object.entries(parts)) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ color: 0xffffff }));
      mesh.name = name;
      group.add(mesh);
    }
    const bytes = await new USDZExporter().parseAsync(group, { quickLookCompatible: false });
    const archive = unzipSync(new Uint8Array(bytes));
    const files = Object.keys(archive);
    expect(files.some((file) => file.endsWith('.usda'))).toBe(true);
    expect(files.filter((file) => file.startsWith('geometries/') && file.endsWith('.usda'))).toHaveLength(3);
  });
});
