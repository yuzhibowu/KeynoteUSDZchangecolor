import { useRef } from 'react';

type Props = {
  selected: number | null;
  hasImage: boolean;
  sizeText: string;
  busy: string | null;
  onFiles: (files: File[]) => void;
  onResetFace: () => void;
  onTestFill: () => void;
  onClearFace: () => void;
  onExport: () => void;
};

export function Toolbar({ selected, hasImage, sizeText, busy, onFiles, onResetFace, onClearFace, onTestFill, onExport }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="toolbar">
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
      <button
        className="primary drop-ok"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          e.currentTarget.classList.add('drag-over');
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
        onDrop={(e) => {
          e.currentTarget.classList.remove('drag-over');
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) return;
          e.preventDefault();
          onFiles(files);
        }}
      >
        上传图片
      </button>
      <span className="upload-hint">点击或直接把文件拖到按钮上 · 单张贴到选中面，多张按文件名依次分配</span>
      <button disabled={selected === null || !hasImage} onClick={onResetFace}>
        重置此面
      </button>
      <button disabled={selected === null || !hasImage} onClick={onClearFace}>
        移除图片
      </button>
      <button className="ghost" onClick={onTestFill} title="给每个面填一张带编号的纯色图，用来验证 Keynote 对「多 mesh 多材质」的支持">
        填充测试色块
      </button>
      <span className="spacer" />
      <span className="size">预估 {sizeText}</span>
      <button className="primary export" onClick={onExport} disabled={busy !== null}>
        {busy ?? '导出 USDZ'}
      </button>
    </div>
  );
}
