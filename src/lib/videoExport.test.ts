import { describe, expect, it } from 'vitest';
import { markAppleProResVendor, safeBaseName, validateExport, waitForExport } from './videoExport';

describe('validateExport', () => {
  it('正常参数返回帧数', () => {
    expect(validateExport({ width: 1920, height: 1080, fps: 30, seconds: 10 }, 16384)).toBe(300);
  });
  it('太大就拒', () => {
    expect(() => validateExport({ width: 3840, height: 2160, fps: 60, seconds: 60 }, 16384)).toThrow(/太大/);
    expect(() => validateExport({ width: 9000, height: 100, fps: 30, seconds: 1 }, 16384)).toThrow();
  });
});

describe('markAppleProResVendor', () => {
  it('FFMP 换成 apl0', () => {
    const d = new Uint8Array([1, 2, 0x46, 0x46, 0x4d, 0x50, 9]);
    expect([...markAppleProResVendor(d)]).toEqual([1, 2, 0x61, 0x70, 0x6c, 0x30, 9]);
  });
});

describe('safeBaseName', () => {
  it('中文保留，非法字符换掉', () => {
    expect(safeBaseName('高达/加动效: v2')).toBe('高达_加动效_ v2');
    expect(safeBaseName('')).toBe('motion');
  });
});

describe('waitForExport', () => {
  it('取消能把等待掐掉', async () => {
    const c = new AbortController();
    const p = waitForExport(new Promise(() => {}), c.signal);
    c.abort();
    await expect(p).rejects.toThrow();
  });
  it('超时也能', async () => {
    await expect(waitForExport(new Promise(() => {}), undefined, 10)).rejects.toThrow(/超时/);
  });
});
