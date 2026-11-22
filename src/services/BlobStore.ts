/** Tiny IndexedDB store for shared files (received and sent), keyed by file id. */
const DB = 'meshcall-files';
const STORE = 'blobs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T | undefined>((resolve) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined; // private mode / blocked storage: files just stay in memory
  }
}

export const blobStore = {
  put: (id: string, blob: Blob) => run('readwrite', (s) => s.put(blob, id)),
  get: (id: string) => run<Blob | undefined>('readonly', (s) => s.get(id) as IDBRequest<Blob | undefined>),
  delete: (id: string) => run('readwrite', (s) => s.delete(id)),
};
