import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_ASSETS, downloadFfmpegCore, verifiedBlobURL } from './ffmpegCore';

afterEach(() => vi.unstubAllGlobals());
const asset = { url: 'https://example.invalid/core', mime: 'text/plain', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' };
describe('固定内核下载及校验', () => {
  it('校验通过的字节才交给调用方，内容不变', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')));
    const url = await verifiedBlobURL(asset);
    // 用真实 fetch 读取 blob URL，确保字节没被转码。
    vi.unstubAllGlobals();
    expect(await (await fetch(url)).text()).toBe('hello');
    URL.revokeObjectURL(url);
  });
  it('拒绝下载错误和不同哈希的文件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status: 503 })));
    await expect(verifiedBlobURL(asset)).rejects.toThrow(/503/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('different')));
    await expect(verifiedBlobURL(asset)).rejects.toThrow(/校验/);
  });
  it('只下载两个固定版本资产，不发送帧数据', async () => {
    const mock = vi.fn(async (url: string) => { void url; return new Response('not-the-release'); });
    vi.stubGlobal('fetch', mock);
    await expect(downloadFfmpegCore()).rejects.toThrow(/校验/);
    expect(mock.mock.calls.map(args => args[0])).toEqual(CORE_ASSETS.map(a => a.url));
  });
});
