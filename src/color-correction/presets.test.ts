import { describe, expect, it } from 'vitest';
import { createCorrectionPreset, PRESET_CONDITIONS } from './index';
import { DEFAULT_COMP, CARD_COMP, FREEFORM_COMP } from '../lib/color';

describe('独立配置不改变原项目默认值', () => {
  it('条件对应现有实测档，端面保留原粗糙度', () => {
    for (const [id, original] of [
      ['keynote-prism', DEFAULT_COMP], ['keynote-card', CARD_COMP], ['freeform-prism', FREEFORM_COMP],
    ] as const) {
      const { comp, conditions } = createCorrectionPreset(id);
      expect(comp).toEqual(original);
      expect(conditions.lift).toBe(original.calibratedLift);
      expect(conditions.unlit).toBe(original.calibratedUnlit);
      expect(conditions.material).toBe(original.calibratedMaterial);
      expect(conditions.capRoughness).toBe(0.85);
    }
  });
  it('嵌套校准数据每次独立，调用方可以安全修改配置', () => {
    const a = createCorrectionPreset();
    a.comp.samples![0].got[0] = -1;
    a.comp.curve![0][0] = -1;
    a.conditions.lift = 0;
    const b = createCorrectionPreset();
    expect(b.comp.samples![0].got[0]).toBeGreaterThanOrEqual(0);
    expect(b.comp.curve).toEqual(DEFAULT_COMP.curve);
    expect(b.conditions.lift).toBe(0.5);
    expect(PRESET_CONDITIONS['keynote-prism'].lift).toBe(0.5);
  });
});
