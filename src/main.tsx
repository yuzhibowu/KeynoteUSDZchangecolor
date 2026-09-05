import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/** 崩了就把原因显示出来，而不是留一片黑屏让人猜 */
class Boundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: 'system-ui', color: '#e7e9ee', lineHeight: 1.7 }}>
        <h2 style={{ fontSize: 16 }}>页面出错了</h2>
        <p style={{ color: '#9aa2b1' }}>
          先试试强制刷新（Mac 上是 Cmd + Shift + R）。还不行的话，下面是原因：
        </p>
        <pre style={{ background: '#1e222b', padding: 12, borderRadius: 6, overflow: 'auto' }}>
          {String(this.state.err?.stack ?? this.state.err)}
        </pre>
        <button
          style={{ padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}
          onClick={() => {
            indexedDB.deleteDatabase('prism-usdz-exporter');
            localStorage.clear();
            location.reload();
          }}
        >
          清空本地数据并重新加载
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);
