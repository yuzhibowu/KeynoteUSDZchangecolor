import { FFmpeg } from '@ffmpeg/ffmpeg';
import { downloadFfmpegCore } from './ffmpegCore';
import { zipSync } from 'fflate';

/**
 * 把逐帧的透明 PNG 编成文件。整套从 3D 项目（~/Documents/3D）搬过来的，那边在
 * Keynote 里验证过：ProRes 4444 XQ 的 MOV 带 alpha，Keynote 直接认。
 *
 * ffmpeg 跑在浏览器独立 Worker 中（单线程，不需要跨域隔离头）。
 * 上游固定版本内核第一次导出时从 CDN 下载并校验，不随仓库/本站分发。
 */

/** 帧数据总量上限：都是 PNG Blob 攒在内存里，超过就停 */
export const FRAME_MEMORY_LIMIT = 192 * 1024 * 1024;

export const VIDEO_SIZES = [
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '4k', label: '4K', width: 3840, height: 2160 },
  { id: 'square', label: '方形 1080', width: 1080, height: 1080 },
] as const;
export type VideoSizeId = (typeof VIDEO_SIZES)[number]['id'];
export const VIDEO_FPS = [24, 30, 60] as const;

export type VideoFormat = 'mov' | 'png';

export function safeBaseName(value: string): string {
  return (
    String(value)
      .normalize('NFC')
      .replace(/[<>:"/\\|?*]|[\x00-\x1f\x7f]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 100) || 'motion'
  );
}

export function validateExport(
  { width, height, fps, seconds }: { width: number; height: number; fps: number; seconds: number },
  maxTextureSize: number,
): number {
  if (![width, height, fps, seconds].every(Number.isFinite) || width < 64 || height < 64 || seconds <= 0 || fps <= 0) {
    throw new Error('尺寸、帧率、时长有一个不对');
  }
  const count = Math.max(1, Math.round(fps * seconds));
  if (width > Math.min(maxTextureSize, 8192) || height > Math.min(maxTextureSize, 8192) || width * height > 32 * 1024 * 1024) {
    throw new Error('输出尺寸太大，这台机器的显卡吃不下');
  }
  if (count > 3600 || width * height * count > 2_000_000_000) {
    throw new Error('这次导出太大了：把循环长度缩短、帧率或尺寸降一档再试');
  }
  return count;
}

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消导出', 'AbortError');
}

/** 等一个 promise，但取消和超时都能把它掐掉 —— 浏览器回调或编码器卡死也不会等到天荒地老 */
export function waitForExport<T>(promise: Promise<T> | T, signal?: AbortSignal, timeout = 120000): Promise<T> {
  checkCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (settle: (v: unknown) => void, value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    const abort = () => finish(reject, signal?.reason ?? new DOMException('已取消导出', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('处理超时，把导出规模降一档再试')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (v) => finish(resolve as (v: unknown) => void, v),
      (e) => finish(reject, e),
    );
  });
}

let coreUrls: Promise<[string, string]> | null = null;

async function loadFfmpeg(signal?: AbortSignal) {
  if (!coreUrls) {
    coreUrls = downloadFfmpegCore();
  }
  let coreURL: string;
  let wasmURL: string;
  try {
    [coreURL, wasmURL] = await waitForExport(coreUrls, signal);
  } catch (e) {
    coreUrls = null;
    throw e;
  }
  const ffmpeg = new FFmpeg();
  const logs: string[] = [];
  ffmpeg.on('log', ({ message }) => {
    logs.push(message);
    if (logs.length > 200) logs.shift();
  });
  await waitForExport(ffmpeg.load({ coreURL, wasmURL }), signal);
  return { ffmpeg, logs };
}

/** ffmpeg 的日志很吵，挑一行像错误的出来给人看 */
function meaningfulError(logs: string[]): string {
  const noise = /^(ffmpeg version|  built with|  configuration:|  libav|libpostproc|Reading option|Splitting|Applying option|Successfully parsed|Parsing a group|Finished splitting|  Stream #|  Duration:|  Metadata:|    encoder|Input #|Output #|frame=|  Total:|Statistics:|video:|audio:|Setting |w:|auto-inserting|query_formats|Selected |Sync level|Changing video|filter context|Autoselected|profile |frame size|cur_dts|EOF on|No more output|Clipping frame|muxing overhead)/i;
  const meaningful = logs.map((l) => l.trim()).filter((l) => l && !noise.test(l));
  const bad = /(error|invalid|failed|unable|cannot|not found|unsupported|out of memory)/i;
  return meaningful.find((l) => bad.test(l)) ?? meaningful[meaningful.length - 1] ?? '';
}

/**
 * ffmpeg 写的 ProRes 厂商标记是 "FFMP"，苹果的工具认的是 "apl0"。
 * 3D 项目实测：不改这四个字节，Keynote / Final Cut 对文件的态度不一样。
 */
export function markAppleProResVendor(data: Uint8Array): Uint8Array {
  const ff = [0x46, 0x46, 0x4d, 0x50]; // FFMP
  const apl = [0x61, 0x70, 0x6c, 0x30]; // apl0
  let n = 0;
  for (let i = 0; i <= data.length - 4; i++) {
    if (ff.every((v, k) => data[i + k] === v)) {
      data.set(apl, i);
      n++;
    }
  }
  if (n !== 1) console.warn(`[MOV] 期望 1 处 FFMP 厂商标记，实际 ${n} 处`);
  return data;
}

/** PNG 序列：打成 zip，PNG 本来就是压过的，STORE 就行 */
export function packPngSequence(frames: Uint8Array[], baseName: string): Blob {
  const files: Record<string, Uint8Array> = {};
  frames.forEach((f, i) => {
    files[`${baseName}_${String(i + 1).padStart(5, '0')}.png`] = f;
  });
  return new Blob([zipSync(files, { level: 0 }) as unknown as BlobPart], { type: 'application/zip' });
}

export async function encodeMov(
  frames: (Blob | null)[],
  fps: number,
  baseName: string,
  signal?: AbortSignal,
  onStatus?: (text: string, progress: number) => void,
): Promise<{ blob: Blob; filename: string }> {
  const { ffmpeg, logs } = await loadFfmpeg(signal);
  const outputName = `${baseName}_prores4444xq.mov`;
  const args = [
    '-framerate', String(fps), '-i', 'frame_%05d.png',
    '-c:v', 'prores_ks', '-profile:v', '5', '-bits_per_mb', '8000',
    '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0',
    outputName,
  ];
  try {
    for (let i = 0; i < frames.length; i++) {
      checkCancelled(signal);
      const f = frames[i]!;
      await waitForExport(ffmpeg.writeFile(`frame_${String(i).padStart(5, '0')}.png`, new Uint8Array(await f.arrayBuffer())), signal);
      frames[i] = null; // 交给编码器就放掉，别两份都攒着
      onStatus?.(`正在准备编码 ${i + 1} / ${frames.length} 帧`, 0.72 + ((i + 1) / frames.length) * 0.1);
    }
    onStatus?.('正在浏览器里编码，别关页面', 0.85);
    const code = await waitForExport(ffmpeg.exec(args), signal, 10 * 60 * 1000);
    if (code !== 0) throw new Error(meaningfulError(logs) || `编码器退出，错误码 ${code}`);
    const out = (await waitForExport(ffmpeg.readFile(outputName), signal)) as Uint8Array;
    return { blob: new Blob([markAppleProResVendor(out) as unknown as BlobPart], { type: 'video/quicktime' }), filename: outputName };
  } finally {
    ffmpeg.terminate();
  }
}
