import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 角落里的小灯泡：点一下冒出一段提示，再点或点外面就收起。
 * 放那些「知道了会用得更好、但不该占地方」的话。
 */
export function Tip({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tip" ref={box}>
      <button type="button" className="tip-bulb" aria-label={title} title={title} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        💡
      </button>
      {open && (
        <div className="tip-pop" role="note">
          <b>{title}</b>
          <div>{children}</div>
        </div>
      )}
    </div>
  );
}
