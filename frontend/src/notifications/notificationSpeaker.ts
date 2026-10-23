/** IndexedDB read/write transactions serialize sound claims across tabs,
 * including HTTP origins where Web Locks and randomUUID are unavailable. */
let database: Promise<IDBDatabase> | null = null;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("webssh-notification-speaker", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("claims");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function claimNotificationSound(userId: string, ids: string[], now = Date.now()): Promise<boolean> {
  try {
    const db = await openDatabase();
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction("claims", "readwrite");
      const store = transaction.objectStore("claims");
      const request = store.get(userId);
      let claimed = false;
      request.onsuccess = () => {
        const records: Array<[string, number]> = Array.isArray(request.result) ? request.result.filter((item: [string, number]) => item[1] > now - 15000).slice(-500) : [];
        const previous = new Set(records.map(([id]) => id));
        const fresh = ids.filter(id => !previous.has(id));
        if (fresh.length) { claimed = true; store.put([...records, ...fresh.map(id => [id, now])].slice(-500), userId); }
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // Restricted storage: still allow sound in the active page. Audio does not
    // depend on database availability; normal origins get atomic tab dedup.
    return document.visibilityState === "visible" && document.hasFocus();
  }
}
