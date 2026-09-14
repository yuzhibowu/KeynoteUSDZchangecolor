import { useRef } from 'react';
import { Slider } from './Slider';
import { FLOAT_LEVELS, type MotionParams } from '../lib/motion';

export type MotionSidebar = {
  fileName: string | null;
  loaded: boolean;
  motion: MotionParams;
  patch: (p: Partial<MotionParams>) => void;
  onPick: (f: File) => void;
  onExport: () => void;
  exportBusy: string | null;
};

/**
 * 加动效模式的侧栏。
 *
 * 参数故意少：做 PPT 的人要的是「轻一点 / 明显一点」，不是「幅度 1.5%、微旋 1.5°」。
 * 漂浮本身就包含上下位移和两个轴的微倾，不让用户自己拼。
 */
export function MotionPanel({ fileName, loaded, motion, patch, onPick, onExport, exportBusy }: MotionSidebar) {
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
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onPick(f);
            }}
          />
          {fileName && <div className="filename" title={fileName}>{fileName}</div>}
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

      <section className="export-block">
        <button className="btn-primary" disabled={!loaded || exportBusy !== null} onClick={onExport}>
          {exportBusy ?? '导出 USDZ'}
        </button>
      </section>
    </>
  );
}
