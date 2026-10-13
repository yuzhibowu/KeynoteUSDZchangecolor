import { CARD_COMP, DEFAULT_COMP, FREEFORM_COMP, type ColorComp } from './core';

export type CorrectionPresetId = 'keynote-prism' | 'keynote-card' | 'freeform-prism';
export type CorrectionConditions = {
  target: 'keynote' | 'freeform';
  shape: 'prism' | 'card';
  material: 'paper';
  roughness: number;
  capRoughness: number;
  metalness: number;
  clearcoat: number;
  opacity: number;
  lift: number;
  unlit: boolean;
};

const paper = {
  material: 'paper' as const, roughness: 0.9, capRoughness: 0.85,
  metalness: 0, clearcoat: 0, opacity: 1, unlit: false,
};
/** 校准条件描述，不会自动改动外部项目的材质或灯光。 */
export const PRESET_CONDITIONS: Readonly<Record<CorrectionPresetId, Readonly<CorrectionConditions>>> = Object.freeze({
  'keynote-prism': Object.freeze({ ...paper, target: 'keynote', shape: 'prism', lift: 0.5 }),
  'keynote-card': Object.freeze({ ...paper, target: 'keynote', shape: 'card', lift: 0.5 }),
  'freeform-prism': Object.freeze({ ...paper, target: 'freeform', shape: 'prism', lift: 0 }),
});

const profiles = { 'keynote-prism': DEFAULT_COMP, 'keynote-card': CARD_COMP, 'freeform-prism': FREEFORM_COMP };

/** 每次返回独立配置，修改 on / 自定义校准数据不会污染内置档或其他调用方。 */
export function createCorrectionPreset(id: CorrectionPresetId = 'keynote-prism'): {
  comp: ColorComp;
  conditions: CorrectionConditions;
} {
  if (!Object.prototype.hasOwnProperty.call(profiles, id)) throw new Error(`Unknown correction preset: ${id}`);
  return {
    comp: JSON.parse(JSON.stringify(profiles[id])) as ColorComp,
    conditions: { ...PRESET_CONDITIONS[id] },
  };
}
