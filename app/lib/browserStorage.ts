import type { AiAnalysis, AiChatMessage, Annotation, DicomSeries } from './types';

const DB_NAME = 'readmri-workspace';
const DB_VERSION = 1;
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'current';

export type PersistedWorkspace = {
  series: DicomSeries[];
  annotations: Annotation[];
  analysis: AiAnalysis;
  activeSeriesId: string;
  sliceIndex: number;
  selectedSeriesIds: string[];
  uploadSummary: string;
  userQuestion: string;
  aiChatHistory?: AiChatMessage[];
  savedAt: string;
};

function openWorkspaceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local MRI storage.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openWorkspaceDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = callback(transaction.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local MRI storage failed.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('Local MRI storage transaction failed.'));
    };
  });
}

export async function loadPersistedWorkspace(): Promise<PersistedWorkspace | null> {
  if (typeof indexedDB === 'undefined') return null;
  return (await withStore('readonly', (store) => store.get(WORKSPACE_KEY))) ?? null;
}

export async function savePersistedWorkspace(workspace: PersistedWorkspace): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.put(workspace, WORKSPACE_KEY));
}

export async function clearPersistedWorkspace(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.delete(WORKSPACE_KEY));
}
