export type UploadFile = File & { webkitRelativePath?: string };

type LegacyFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type LegacyFileSystemFileEntry = LegacyFileSystemEntry & {
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
};

type LegacyFileSystemDirectoryReader = {
  readEntries: (successCallback: (entries: LegacyFileSystemEntry[]) => void, errorCallback?: (error: DOMException) => void) => void;
};

type LegacyFileSystemDirectoryEntry = LegacyFileSystemEntry & {
  createReader: () => LegacyFileSystemDirectoryReader;
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => unknown;
};

function isDirectoryEntry(entry: LegacyFileSystemEntry): entry is LegacyFileSystemDirectoryEntry {
  return entry.isDirectory;
}

function isFileEntry(entry: LegacyFileSystemEntry): entry is LegacyFileSystemFileEntry {
  return entry.isFile;
}

function readEntryFile(entry: LegacyFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectoryEntries(entry: LegacyFileSystemDirectoryEntry): Promise<LegacyFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: LegacyFileSystemEntry[] = [];

  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    entries.push(...batch);
  }

  return entries;
}

async function collectEntryFiles(entry: LegacyFileSystemEntry): Promise<File[]> {
  if (isFileEntry(entry)) return [await readEntryFile(entry)];
  if (!isDirectoryEntry(entry)) return [];

  const children = await readDirectoryEntries(entry);
  const nested = await Promise.all(children.map((child) => collectEntryFiles(child)));
  return nested.flat();
}

function toLegacyEntry(entry: unknown): LegacyFileSystemEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as Partial<LegacyFileSystemEntry>;
  return typeof candidate.isFile === 'boolean' && typeof candidate.isDirectory === 'boolean' ? candidate as LegacyFileSystemEntry : null;
}

export async function getFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => toLegacyEntry((item as DataTransferItemWithEntry).webkitGetAsEntry?.()))
    .filter((entry): entry is LegacyFileSystemEntry => entry !== null);

  if (entries.length === 0) return Array.from(dataTransfer.files);

  const files = await Promise.all(entries.map((entry) => collectEntryFiles(entry)));
  return files.flat();
}

export function describeFiles(files: UploadFile[]) {
  const dicomCandidates = files.filter((file) => file.size > 0);
  const skipped = files.length - dicomCandidates.length;
  const folderCount = new Set(
    files
      .map((file) => file.webkitRelativePath?.split('/').slice(0, -1).join('/'))
      .filter(Boolean),
  ).size;

  return {
    dicomCandidates,
    summary: `${dicomCandidates.length.toLocaleString()} file${dicomCandidates.length === 1 ? '' : 's'} selected${folderCount ? ` from ${folderCount.toLocaleString()} folder${folderCount === 1 ? '' : 's'}` : ''}${skipped ? ` (${skipped.toLocaleString()} empty skipped)` : ''}.`,
  };
}
