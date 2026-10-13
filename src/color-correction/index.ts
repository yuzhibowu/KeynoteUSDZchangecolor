/** 公共入口：纯 TypeScript，不依赖 React、Three.js、DOM 或 FFmpeg。 */
export {
  DEFAULT_COMP, CARD_COMP, FREEFORM_COMP, BLANK_COMP,
  BUILT_IN_PROFILE, BUILT_IN_CARD_PROFILE, FREEFORM_PROFILE,
  applyToImageData, applyForwardToImageData, applyToHex, compensateToLinear,
  solveWritten, forwardOf, predictKeynote, isIdentity, compSignature,
  srgbToLinear, linearToSrgb, LOCAL_SIGMA,
} from './core';
export type { ColorComp, Triple } from './core';
export { parseProfile, serializeProfile, profileFileName } from './profile';
export type { ProfileFile, ParseResult } from './profile';
export { createCorrectionPreset, PRESET_CONDITIONS } from './presets';
export type { CorrectionPresetId, CorrectionConditions } from './presets';
