/** 独立 Worker 使用上游发布内核；仓库与 dist 不再携带 FFmpeg 二进制。 */
export const FFMPEG_CORE_VERSION = '0.12.10';
const base = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;
export const CORE_ASSETS = [
  { url: `${base}/ffmpeg-core.js`, mime: 'text/javascript', sha256: '67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3' },
  { url: `${base}/ffmpeg-core.wasm`, mime: 'application/wasm', sha256: '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7' },
] as const;

/** 先校验发布文件，再创建 Worker 可用的 blob URL。只请求代码，不传用户图片。 */
export async function verifiedBlobURL(asset: { url: string; mime: string; sha256: string }): Promise<string> {
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`编码器下载失败（${response.status}），请检查网络后重试`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== asset.sha256) throw new Error('编码器文件校验不通过，请刷新页面后重试');
  return URL.createObjectURL(new Blob([bytes], { type: asset.mime }));
}

export async function downloadFfmpegCore(): Promise<[string, string]> {
  const results = await Promise.allSettled(CORE_ASSETS.map(verifiedBlobURL));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    for (const r of results) if (r.status === 'fulfilled') URL.revokeObjectURL(r.value);
    throw failed.reason;
  }
  return results.map(r => (r as PromiseFulfilledResult<string>).value) as [string, string];
}
