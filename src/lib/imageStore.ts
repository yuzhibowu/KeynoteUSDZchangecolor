/**
 * 贴图本体存 IndexedDB。
 *
 * 参数和 face transform 走 localStorage 就够了，但图片太大塞不进去，
 * 结果就是一刷新贴图全没、得重新上传一遍。IndexedDB 没这个限制。
 */
/**
 * 库名带版本：换版本等于把之前存的贴图（包括早期测试用的照片）一起作废，
 * 打开就是干净的默认彩色块。
 */
const DB = 'prism-usdz-exporter-v2';
const STORE = 'faces';

export type StoredFace = { index: number; blob: Blob; name: string };

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'index' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveFace(index: number, blob: Blob, name: string) {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ index, blob, name });
  } catch {
    /* 隐私模式 / 配额满，忽略 */
  }
}

export async function clearFace(index: number) {
  const db = await open();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(index);
  } catch {
    /* 忽略 */
  }
}

export async function loadFaces(): Promise<StoredFace[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as StoredFace[]);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
