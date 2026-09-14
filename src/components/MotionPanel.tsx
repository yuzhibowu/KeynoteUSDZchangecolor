import { useRef } from 'react';
import { Slider } from './Slider';
import { ENTRANCES, FLOAT_LEVELS, LOOP_SECONDS, PATHS, effectiveLap, type MotionParams } from '../lib/motion';

export type MotionSidebar = {
  fileName: string | null;
  /** 除了预览的那个，还有哪些一起导出 */
  extraNames: string[];
  loaded: boolean;
  motion: MotionParams;
  patch: (p: Partial<MotionParams>) => void;
  drawing: boolean;
  setDrawing: (v: boolean) => void;
  onPick: (files: File[]) => void;
  onExport: () => void;
  exportBusy: string | null;
};

/**
 * 加动效模式的侧栏。
 *
 * 参数故意少：做 PPT 的人要的是「轻一点 / 明显一点」，不是「幅度 1.5%、微旋 1.5°」。
 * 漂浮本身就包含上下位移和两个轴的微倾，不让用户自己拼。
 */
export function MotionPanel({ fileName, extraNames, loaded, motion, patch, drawing, setDrawing, onPick, onExport, exportBusy }: MotionSidebar) {
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
              还有 {extraNames.length} 个一起导出：{extraNames.join('、')}。
              同一套设定，每个自动错开一点相位，不会一起起伏。
            </p>
          )}
        </div>
      </section>

      <section>
        <h2>漂浮</h2>
        <div className="stack">
          <div className="opts four">
            {FLOAT_LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                className="opt"
                aria-pressed={motion.float === l.id}
                onClick={() => patch({ float: l.id })}
              >
                {l.label}
              </button>
            ))}
          </div>
          <Slider
            label="节奏"
            value={motion.speed}
            min={0.5}
            max={2}
            step={0.05}
            digits={2}
            suffix="×"
            reset={1}
            snaps={[1]}
            disabled={motion.float === 'off'}
            onChange={(v) => patch({ speed: v })}
          />
          <Slider
            label="错开"
            value={motion.phase}
            min={0}
            max={10}
            step={0.1}
            digits={1}
            suffix=" 秒"
            reset={0}
            disabled={motion.float === 'off'}
            onChange={(v) => patch({ phase: v })}
          />
          <p className="hint">
            上下起伏加两个方向的微倾，三个节奏互不重合，看不出在循环。
            同一页放几个模型时，每个「错开」不同的秒数，它们就不会一起起伏。
          </p>
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
                value={motion.pathLap}
                min={3}
                max={20}
                step={0.5}
                digits={1}
                suffix=" 秒"
                note={`实际 ${effectiveLap(motion).toFixed(1)} 秒`}
                reset={8}
                onChange={(v) => patch({ pathLap: v })}
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
                在屏幕平面里跑，和漂浮叠加。一圈用时会吸附到能整除循环长度的值，接缝才闭合。
              </p>
            </>
          )}
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
          <p className="hint">
            Keynote 从第 0 帧开始播：模型先入场，再接进漂浮。循环到结尾会用同样的方式退场，
            所以每一圈都会重演一次；想少见到就把下面的循环长度拉长。
          </p>
        </div>
      </section>

      <section>
        <h2>循环长度</h2>
        <div className="stack">
          <div className="opts">
            {LOOP_SECONDS.map((s) => (
              <button
                key={s}
                type="button"
                className="opt"
                aria-pressed={motion.seconds === s}
                onClick={() => patch({ seconds: s })}
              >
                {s} 秒
              </button>
            ))}
          </div>
          <p className="hint">
            导出时烘成这么长的一圈，末尾平滑接回开头。越长越看不出重复，文件不会因此变大多少。
          </p>
        </div>
      </section>

      <section className="export-block">
        <p className="hint tight">文件直接存进「下载」文件夹，不弹保存框。</p>
        <button className="btn-primary" disabled={!loaded || exportBusy !== null} onClick={onExport}>
          {exportBusy ?? (extraNames.length ? `导出全部 ${extraNames.length + 1} 个（打包 zip）` : '导出 USDZ')}
        </button>
      </section>
    </>
  );
}
