/**
 * 把主线程让出去一拍，让浏览器有机会把界面画出来。
 *
 * **不能用 requestAnimationFrame**：标签页切到后台（或者窗口被挡住）时 rAF 根本不触发，
 * 导出会卡在「烘焙贴图 1/N…」永远不动 —— 实测就是这么挂住的。
 * setTimeout 在后台页也会被节流到 1 秒一次，一二十张贴图就要多等十几秒。
 * MessageChannel 派发的是普通宏任务，前台后台都不节流，才是这里要的东西。
 */
let channel: MessageChannel | null = null;
export function yieldToBrowser(): Promise<void> {
  if (typeof MessageChannel !== 'function') {
    return new Promise((r) => setTimeout(r, 0));
  }
  channel ??= new MessageChannel();
  const ch = channel;
  return new Promise((resolve) => {
    const done = () => {
      ch.port1.removeEventListener('message', done);
      resolve();
    };
    ch.port1.addEventListener('message', done);
    ch.port1.start();
    ch.port2.postMessage(0);
  });
}
