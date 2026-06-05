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

const DICOM_EXTENSIONS = new Set(['.dcm', '.dicom', '.ima']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']);
const KNOWN_NON_DICOM_EXTENSIONS = new Set([
  '.bmp',
  '.css',
  '.dll',
  '.exe',
  '.gif',
  '.htm',
  '.html',
  '.ini',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.pdf',
  '.png',
  '.rtf',
  '.txt',
  '.xml',
]);

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

function uploadPath(file: UploadFile) {
  return file.webkitRelativePath || file.name;
}

export function extensionOf(file: UploadFile) {
  const name = uploadPath(file).toLowerCase();
  const lastSegment = name.split('/').pop() || name;
  const dotIndex = lastSegment.lastIndexOf('.');
  return dotIndex >= 0 ? lastSegment.slice(dotIndex) : '';
}

export function isVideoFile(file: UploadFile) {
  return VIDEO_EXTENSIONS.has(extensionOf(file)) || VIDEO_MIME_TYPES.has(file.type.toLowerCase());
}

async function hasDicomPreamble(file: UploadFile) {
  if (file.size < 132) return false;
  const header = new Uint8Array(await file.slice(128, 132).arrayBuffer());
  return header[0] === 0x44 && header[1] === 0x49 && header[2] === 0x43 && header[3] === 0x4d;
}

export async function getDicomCandidateFiles(files: UploadFile[]): Promise<{ dicomCandidates: UploadFile[]; skippedNonDicom: number }> {
  const candidates: UploadFile[] = [];
  let skippedNonDicom = 0;

  for (const file of files) {
    if (file.size === 0) continue;

    const extension = extensionOf(file);
    if (isVideoFile(file)) {
      skippedNonDicom += 1;
      continue;
    }

    if (DICOM_EXTENSIONS.has(extension) || await hasDicomPreamble(file)) {
      candidates.push(file);
      continue;
    }

    if (!extension || /(^|\/)dicom(dir)?$/i.test(uploadPath(file))) {
      candidates.push(file);
      continue;
    }

    if (KNOWN_NON_DICOM_EXTENSIONS.has(extension)) {
      skippedNonDicom += 1;
      continue;
    }

    candidates.push(file);
  }

  return { dicomCandidates: candidates, skippedNonDicom };
}

export function describeFiles(files: UploadFile[], dicomCandidateCount?: number, archiveCount = 0, skippedNonDicom = 0, videoCount = 0) {
  const nonEmpty = files.filter((file) => file.size > 0);
  const skippedEmpty = files.length - nonEmpty.length;
  const selectedCount = dicomCandidateCount ?? nonEmpty.length;
  const folderCount = new Set(
    files
      .map((file) => file.webkitRelativePath?.split('/').slice(0, -1).join('/'))
      .filter(Boolean),
  ).size;

  return {
    summary: `${selectedCount.toLocaleString()} DICOM candidate${selectedCount === 1 ? '' : 's'}${videoCount ? ` and ${videoCount.toLocaleString()} video${videoCount === 1 ? '' : 's'}` : ''} selected${folderCount ? ` from ${folderCount.toLocaleString()} folder${folderCount === 1 ? '' : 's'}` : ''}${archiveCount ? ` after unpacking ${archiveCount.toLocaleString()} archive${archiveCount === 1 ? '' : 's'}` : ''}${skippedNonDicom ? ` (${skippedNonDicom.toLocaleString()} viewer/document file${skippedNonDicom === 1 ? '' : 's'} skipped)` : ''}${skippedEmpty ? ` (${skippedEmpty.toLocaleString()} empty skipped)` : ''}.`,
  };
}
