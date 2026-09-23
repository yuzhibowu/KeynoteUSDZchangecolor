import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CAP_ROUGHNESS,
  FACE_ROUGHNESS,
  METALNESS,
  applyLift,
  makeCapMaterial,
  makeFaceMaterial,
  isTuned,
  materialPreset,
} from './material';
import { CARD_BACK, CARD_FRONT, materialOf } from './types';

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

describe('卡片背面单独设材质', () => {
  const base = { modelType: 'card' as const, material: 'paper' as const };

  it('没单独设时，正反都跟着 params.material', () => {
    expect(materialOf(base, CARD_FRONT)).toBe('paper');
    expect(materialOf(base, CARD_BACK)).toBe('paper');
  });

  it('设了之后只有背面变，正面和窄边不受影响', () => {
    const p = { ...base, materialBack: 'plastic' as const };
    expect(materialOf(p, CARD_FRONT)).toBe('paper');
    expect(materialOf(p, CARD_BACK)).toBe('plastic');
    // 槽位 1 是卡片那圈窄边 —— 跟着正面走
    expect(materialOf(p, 1)).toBe('paper');
  });

  it('棱柱不吃这一项 —— 它没有「背面」这个概念，槽位 2 是第 3 个侧面', () => {
    const p = { modelType: 'prism' as const, material: 'paper' as const, materialBack: 'metal' as const };
    expect(materialOf(p, CARD_BACK)).toBe('paper');
  });
});

describe('材质微调：预设只是起点', () => {
  it('没调过就完全等于预设', () => {
    expect(materialPreset('metal')).toEqual(materialPreset('metal', undefined));
    expect(isTuned('metal')).toBe(false);
  });

  /** 金属在无边记里黑不隆冬的解法：金属度 1 = 漫反射归零、全靠反射环境，降下来颜色就回来 */
  it('调金属度只动金属度，其余跟着预设', () => {
    const t = materialPreset('metal', { metalness: 0.8 });
    expect(t.metalness).toBeCloseTo(0.8);
    expect(t.roughness).toBe(materialPreset('metal').roughness);
    expect(isTuned('metal', { metalness: 0.8 })).toBe(true);
  });

  /** 玻璃掉色的解法：opacity 0.6 会把背后的白画布透上来 */
  it('调不透明度能把玻璃从 0.6 拉回不透', () => {
    expect(materialPreset('glass').opacity).toBe(0.6);
    expect(materialPreset('glass', { opacity: 1 }).opacity).toBe(1);
  });

  it('粗糙度一调，端面/窄边跟着一起调 —— 同一块材料不该正面磨砂侧边镜面', () => {
    const t = materialPreset('paper', { roughness: 0.2 });
    expect(t.roughness).toBeCloseTo(0.2);
    expect(t.capRoughness).toBeCloseTo(0.2);
  });

  it('把值调回预设的数，就不算「已改」', () => {
    expect(isTuned('metal', { metalness: materialPreset('metal').metalness })).toBe(false);
  });
});
