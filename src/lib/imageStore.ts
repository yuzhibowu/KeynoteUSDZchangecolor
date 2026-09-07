/**
 * 贴图本体存 IndexedDB。
 *
 * 参数和 face transform 走 localStorage 就够了，但图片太大塞不进去，
 * 结果就是一刷新贴图全没、得重新上传一遍。IndexedDB 没这个限制。
 */
/**
 * 库名带版本：换版本等于把之前存的贴图一起作废，打开就是干净的默认纯色。
 *
 * v3 是为了清掉早期那批带字母的示例图（front.png / back-F.png 这些）——
 * 它们存在 IndexedDB 里，改代码是清不掉的，只有换库名才会真的不再被读回来。
 */
const DB = 'prism-usdz-exporter-v3';
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
