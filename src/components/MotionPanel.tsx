import { useRef } from 'react';
import { Slider } from './Slider';
import { ENTRANCES, FLOAT_SNAPS, LOOP_SECONDS, PATHS, SPIN_AXES, bakeFps, effectiveLap, effectiveSpinLap, loopLabel, randomPhase, snapLap, type MotionParams } from '../lib/motion';
import { VIDEO_FPS, VIDEO_SIZES, type VideoFormat, type VideoSizeId } from '../lib/videoExport';

export type MotionSidebar = {
  fileName: string | null;
  /** 除了预览的那个，还有哪些一起导出 */
  extraNames: string[];
  loaded: boolean;
  motion: MotionParams;
  patch: (p: Partial<MotionParams>) => void;
  drawing: boolean;
  setDrawing: (v: boolean) => void;
  /** 预览背景：'dark' | 'slide' | 自定义颜色 */
  background: string;
  setBackground: (v: string) => void;
  zoom: number;
  setZoom: (v: number) => void;
  onPick: (files: File[]) => void;
  onExport: () => void;
  exportBusy: string | null;
  video: {
    size: VideoSizeId;
    fps: number;
    setSize: (v: VideoSizeId) => void;
    setFps: (v: number) => void;
    busy: string | null;
    onExport: (format: VideoFormat) => void;
    onCancel: () => void;
  };
};

/**
 * 加动效模式的侧栏。
 *
 * 参数故意少：做 PPT 的人要的是「轻一点 / 明显一点」，不是「幅度 1.5%、微旋 1.5°」。
 * 漂浮本身就包含上下位移和两个轴的微倾，不让用户自己拼。
 */
export function MotionPanel({ fileName, extraNames, loaded, motion, patch, drawing, setDrawing, background, setBackground, zoom, setZoom, onPick, onExport, exportBusy, video }: MotionSidebar) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <section className="bare">
        <div className="stack">
          <button className="btn" onClick={() => input.current?.click()}>
            选择 USDZ 文件
          </button>
          <input
            ref={input}
            type="file"
            accept=".usdz,model/vnd.usdz+zip"
            multiple
            hidden
            onChange={(e) => {
              const fs = [...(e.target.files ?? [])];
              e.target.value = '';
              if (fs.length) onPick(fs);
            }}
          />
          {fileName && <div className="filename" title={fileName}>{fileName}</div>}
          {extraNames.length > 0 && (
            <p className="hint">
              共 {extraNames.length + 1} 个一起导出，同一套设定，起步逐个错开 —— 左边每块就是各自导出后的样子。
            </p>
          )}
        </div>
      </section>

      <section>
        <h2>循环长度</h2>
        <div className="stack">
          <div className="opts five">
            {LOOP_SECONDS.map((s) => (
              <button
                key={s}
                type="button"
                className="opt"
                aria-pressed={motion.seconds === s}
                onClick={() => patch({ seconds: s })}
              >
                {loopLabel(s)}
              </button>
            ))}
          </div>
          <p className="hint">
            所有动作都在这一圈里：漂浮末尾平滑接回开头，自转和轨迹要转整数圈。
            越长越看不出重复、一圈用时的档位越细。5 / 10 分钟是给「播放一次」用的：入场只演一次，
            漂到结束，一页讲完都不会重演；按 {bakeFps(motion.seconds)} fps 烘，文件会大几 MB。
            导出视频的时长也是它，最多取前 60 秒。
          </p>
        </div>
      </section>

      <section>
        <h2>入场</h2>
        <div className="stack">
          <div className="opts four">
            {ENTRANCES.map((e) => (
              <button
                key={e.id}
                type="button"
                className="opt"
                aria-pressed={motion.entrance === e.id}
                onClick={() => patch({ entrance: e.id })}
              >
                {e.label}
              </button>
            ))}
          </div>
          <Slider
            label="入场用时"
            value={motion.entranceSeconds}
            min={0.5}
            max={3}
            step={0.1}
            digits={1}
            suffix=" 秒"
            reset={1.5}
            disabled={motion.entrance === 'none'}
            onChange={(v) => patch({ entranceSeconds: v })}
          />
          <div className="opts">
            <button
              type="button"
              className="opt"
              aria-pressed={motion.exit !== false}
              disabled={motion.entrance === 'none'}
              onClick={() => patch({ exit: true })}
            >
              结尾退场（循环）
            </button>
            <button
              type="button"
              className="opt"
              aria-pressed={motion.exit === false}
              disabled={motion.entrance === 'none'}
              onClick={() => patch({ exit: false })}
            >
              只入场一次（播放一次）
            </button>
          </div>
          <p className="hint">
            {motion.exit === false
              ? `入场一次，然后一直漂到循环长度结束、停在最后一帧，播放器设成「播放一次」。Keynote 的 3D 动画时钟是放映一开始就起跑的，翻到这页不会重来，所以入场只在放映从这页开始时才看得到；别的软件按它自己的规矩来。`
              : `模型先入场，再接进漂浮；循环到结尾用同样的方式退场，回到第 0 帧接缝是平的，所以每一圈都会重演一次。每次打开工具都从「无」开始，需要再选。`}
          </p>
        </div>
      </section>

      <section>
        <h2>漂浮</h2>
        <div className="stack">
          <Slider
            label="幅度"
            value={motion.floatAmount}
            min={0}
            max={3}
            step={0.05}
            digits={2}
            suffix=" ×"
            note={motion.floatAmount === 0 ? '不动' : undefined}
            reset={1}
            snaps={FLOAT_SNAPS.map((x) => x.value)}
            snapLabels={FLOAT_SNAPS.map((x) => x.label)}
            onChange={(v) => patch({ floatAmount: v })}
          />
          <Slider
            label="节奏"
            value={motion.speed}
            min={0.3}
            max={3}
            step={0.05}
            digits={2}
            suffix="×"
            reset={1}
            snaps={[1]}
            disabled={motion.floatAmount === 0}
            onChange={(v) => patch({ speed: v })}
          />
          <Slider
            label="起步错开"
            value={motion.phase}
            min={0}
            max={10}
            step={0.1}
            digits={1}
            suffix=" 秒"
            reset={0}
            disabled={motion.floatAmount === 0}
            onChange={(v) => patch({ phase: v })}
          />
          <button
            className="btn"
            disabled={motion.floatAmount === 0}
            onClick={() => patch({ phase: randomPhase(motion.phase, motion.seconds) })}
          >
            随机错开一个
          </button>
          <p className="hint">
            上下起伏加两个方向的微倾，三个节奏互不重合，看不出在循环。幅度管动多远，节奏管动多快。
            「起步错开」是从动作的第几秒起步：同一页放几个模型时各自错开，就不会像一队人齐步走。
            一次拖进多个时每块自动错开，左边预览里就是各自的样子。
          </p>
        </div>
      </section>

      <section>
        <h2>自转</h2>
        <div className="stack">
          <div className="opts four">
            {SPIN_AXES.map((a) => (
              <button
                key={a.id}
                type="button"
                className="opt"
                aria-pressed={motion.spin === a.id}
                onClick={() => patch({ spin: a.id })}
              >
                {a.label}
              </button>
            ))}
          </div>
          {motion.spin !== 'none' && (
            <>
              <Slider
                label="一圈用时"
                value={effectiveSpinLap(motion)}
                min={2}
                max={motion.seconds}
                step={0.1}
                digits={1}
                suffix=" 秒"
                note={`循环 ${motion.seconds} 秒里转 ${Math.round(motion.seconds / effectiveSpinLap(motion))} 圈`}
                reset={snapLap(12, motion.seconds)}
                onChange={(v) => patch({ spinLap: snapLap(v, motion.seconds) })}
              />
              <div className="opts">
                <button type="button" className="opt" aria-pressed={motion.spinClockwise} onClick={() => patch({ spinClockwise: true })}>
                  顺时针
                </button>
                <button type="button" className="opt" aria-pressed={!motion.spinClockwise} onClick={() => patch({ spinClockwise: false })}>
                  逆时针
                </button>
              </div>
              <p className="hint">
                Y 轴是竖着的，像转台；X 轴前后翻，Z 轴在屏幕里打转。一个循环里必须转整数圈，接缝才闭合，
                所以一圈用时只能是循环长度除以整数 —— 想要更细的档位，把下面的循环长度拉到 60 秒。
              </p>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>轨迹</h2>
        <div className="stack">
          <div className="opts four">
            {PATHS.map((k) => (
              <button
                key={k.id}
                type="button"
                className="opt"
                aria-pressed={motion.path === k.id}
                onClick={() => patch({ path: k.id })}
              >
                {k.label}
              </button>
            ))}
          </div>
          {motion.path === 'custom' && (
            <>
              <button className="btn" disabled={!loaded} aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>
                {drawing ? '取消' : motion.customPath.length ? '重新画一条' : '画一条'}
              </button>
              <p className="hint">
                {motion.customPath.length
                  ? `已画好 · ${motion.customClosed ? '首尾接上了，绕着走' : '没接上，来回走'}`
                  : '在左边视口里按住拖一笔。首尾接上就绕着走，没接上就来回走。'}
              </p>
            </>
          )}
          {motion.path !== 'none' && (
            <>
              <Slider
                label="大小"
                value={motion.pathSize}
                min={0.2}
                max={3}
                step={0.05}
                digits={2}
                suffix=" ×"
                note="模型半径的倍数"
                reset={1}
                onChange={(v) => patch({ pathSize: v })}
              />
              {motion.path !== 'line' && motion.path !== 'custom' && (
                <Slider
                  label="扁度"
                  value={motion.pathAspect}
                  min={0.1}
                  max={1}
                  step={0.05}
                  digits={2}
                  note="竖 / 横"
                  reset={0.45}
                  onChange={(v) => patch({ pathAspect: v })}
                />
              )}
              <Slider
                label="一圈用时"
                value={effectiveLap(motion)}
                min={2}
                max={motion.seconds}
                step={0.1}
                digits={1}
                suffix=" 秒"
                note={`循环 ${motion.seconds} 秒里跑 ${Math.round(motion.seconds / effectiveLap(motion))} 圈`}
                reset={snapLap(8, motion.seconds)}
                onChange={(v) => patch({ pathLap: snapLap(v, motion.seconds) })}
              />
              <div className="opts">
                <button
                  type="button"
                  className="opt"
                  aria-pressed={motion.pathClockwise}
                  onClick={() => patch({ pathClockwise: true })}
                >
                  顺时针
                </button>
                <button
                  type="button"
                  className="opt"
                  aria-pressed={!motion.pathClockwise}
                  onClick={() => patch({ pathClockwise: false })}
                >
                  逆时针
                </button>
              </div>
              <label className="check">
                <input type="checkbox" checked={motion.pathBank} onChange={(e) => patch({ pathBank: e.target.checked })} />
                <span>沿路径倾斜</span>
              </label>
              <p className="hint">
                在屏幕平面里跑，和漂浮叠加。一个循环里必须跑整数圈，接缝才闭合，
                所以一圈用时只能是循环长度除以整数；想要更细的档位，把循环长度拉到 60 秒。
              </p>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>预览背景</h2>
        <div className="stack">
          <div className="opts">
            <button type="button" className="opt" aria-pressed={background === 'dark'} onClick={() => setBackground('dark')}>
              深色
            </button>
            <button type="button" className="opt" aria-pressed={background === 'slide'} onClick={() => setBackground('slide')}>
              白色幻灯片
            </button>
            <label className="opt color-opt" aria-pressed={background !== 'dark' && background !== 'slide'}>
              自定义
              <input
                type="color"
                value={background.startsWith('#') ? background : '#dfe6ee'}
                onChange={(e) => setBackground(e.target.value)}
              />
            </label>
          </div>
          <Slider
            label="取景"
            value={zoom}
            min={0.5}
            max={3}
            step={0.05}
            digits={2}
            suffix=" ×"
            reset={1.2}
            snaps={[1]}
            onChange={setZoom}
          />
          <p className="hint">
            只影响这里怎么看和导出的视频，不进 USDZ。选幻灯片时视口按 16:9 来框，就是放进 Keynote 的样子；
            取景 1 是把整段运动刚好装下。
          </p>
        </div>
      </section>


      <section>
        <h2>导出视频</h2>
        <div className="stack">
          <div className="opts">
            {VIDEO_SIZES.map((v) => (
              <button key={v.id} type="button" className="opt" aria-pressed={video.size === v.id} onClick={() => video.setSize(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="opts">
            {VIDEO_FPS.map((f) => (
              <button key={f} type="button" className="opt" aria-pressed={video.fps === f} onClick={() => video.setFps(f)}>
                {f} fps
              </button>
            ))}
          </div>
          <p className="hint">
            透明背景，时长就是循环长度（{Math.min(motion.seconds, 60)} 秒，{Math.min(motion.seconds, 60) * video.fps} 帧），用当前的视角。
            MOV 是 ProRes 4444 带 alpha，直接拖进 Keynote 或视频画布。全在浏览器里算，第一次要先下 32 MB 的编码器。
          </p>
          {video.busy ? (
            <div className="row">
              <span className="filename">{video.busy}</span>
              <button className="btn" onClick={video.onCancel}>取消</button>
            </div>
          ) : (
            <div className="row">
              <button className="btn" disabled={!loaded || exportBusy !== null} onClick={() => video.onExport('mov')}>
                透明 MOV
              </button>
              <button className="btn" disabled={!loaded || exportBusy !== null} onClick={() => video.onExport('png')}>
                PNG 序列
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="export-block">
        <p className="hint tight">文件直接存进「下载」文件夹，不弹保存框。</p>
        <button className="btn-primary" disabled={!loaded || exportBusy !== null || video.busy !== null} onClick={onExport}>
          {exportBusy ?? (extraNames.length ? `导出全部 ${extraNames.length + 1} 个（打包 zip）` : '导出 USDZ')}
        </button>
      </section>
    </>
  );
}
