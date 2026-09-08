import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CAP_ROUGHNESS,
  FACE_ROUGHNESS,
  METALNESS,
  applyLift,
  makeCapMaterial,
  makeFaceMaterial,
} from './material';

/**
 * 这一组测试守的是一件事：**色卡棱柱和实际导出的模型必须是同一个东西**。
 *
 * 它们之间任何差异都会被当成 Keynote 的偏色测进校准档，再反过来污染每一次导出，
 * 而症状只是「颜色莫名其妙不准」，几乎无法定位。实际发生过：色卡用
 * MeshStandardMaterial、成品用 MeshPhysicalMaterial，各写各的，没人发现。
 */
describe('材质只有一个来源', () => {
  it('侧面：MeshPhysicalMaterial，不是 Standard', () => {
    const m = makeFaceMaterial(null);
    // Standard 也叫 MeshStandardMaterial 的子类，所以用这个标志位判断
    expect((m as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial).toBe(true);
    expect(m.roughness).toBe(FACE_ROUGHNESS);
    expect(m.metalness).toBe(METALNESS);
  });

  it('端面：同样是 Physical，粗糙度用端面那一档', () => {
    const m = makeCapMaterial(0xd9d9de);
    expect((m as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial).toBe(true);
    expect(m.roughness).toBe(CAP_ROUGHNESS);
    expect(m.metalness).toBe(METALNESS);
  });

  it('侧面比端面粗糙 —— 高粗糙度压制高光对贴图颜色的干扰', () => {
    expect(FACE_ROUGHNESS).toBeGreaterThan(CAP_ROUGHNESS);
  });
});

describe('补光', () => {
  const tex = () => new THREE.Texture();

  it('补光 > 0 必须同时挂 emissiveMap，否则加法那项不跟着贴图走', () => {
    const m = makeFaceMaterial(null);
    const t = tex();
    applyLift(m, t, 1, false);
    expect(m.emissiveMap).toBe(t);
    expect(m.emissive.r).toBe(1);
  });

  it('补光为 0 时不挂 emissiveMap', () => {
    const m = makeFaceMaterial(null);
    applyLift(m, tex(), 0, false);
    expect(m.emissiveMap).toBe(null);
    expect(m.emissive.r).toBe(0);
  });

  it('关掉灯光：diffuse 压黑，自发光拉满', () => {
    const m = makeFaceMaterial(null);
    applyLift(m, tex(), 0, true);
    expect(m.color.r).toBe(0);
    expect(m.emissive.r).toBe(1);
  });

  it('补光超出 0..1 会被夹住，不会写出诡异的值', () => {
    const m = makeFaceMaterial(null);
    applyLift(m, tex(), 5, false);
    expect(m.emissive.r).toBe(1);
    applyLift(m, tex(), -2, false);
    expect(m.emissive.r).toBe(0);
  });
});
