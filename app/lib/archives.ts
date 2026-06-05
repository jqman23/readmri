import type { UploadFile } from './upload';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_DEPTH = 3;
const MAX_EXPANDED_FILES = 15000;

export type ArchiveExpansionResult = {
  files: UploadFile[];
  warnings: string[];
  archiveCount: number;
};

type ArchiveFile = {
  file: UploadFile;
  archiveCount: number;
};

function fileName(file: File) {
  return (file as UploadFile).webkitRelativePath || file.name;
}

function lowerName(file: File) {
  return fileName(file).toLowerCase();
}

function isZip(file: File) {
  const name = lowerName(file);
  return name.endsWith('.zip') || name.endsWith('.dicomzip');
}

function isGzip(file: File) {
  const name = lowerName(file);
  return name.endsWith('.gz') || name.endsWith('.tgz');
}

function isTar(file: File) {
  const name = lowerName(file);
  return name.endsWith('.tar');
}

function isArchive(file: File) {
  return isZip(file) || isGzip(file) || isTar(file);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function makeUploadFile(content: Uint8Array, name: string, type = ''): UploadFile {
  const safeName = name.replace(/^\/+/, '') || 'dicom-file';
  return new File([toArrayBuffer(content)], safeName.split('/').pop() || safeName, { type }) as UploadFile;
}

function withRelativePath(file: UploadFile, path: string): UploadFile {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: path.replace(/^\/+/, ''),
    });
  } catch {
    // Some browsers make File properties non-configurable; the file name still carries enough context.
  }
  return file;
}

function getString(bytes: Uint8Array, offset: number, length: number) {
  return new TextDecoder().decode(bytes.slice(offset, offset + length)).replace(/\0+$/, '');
}

function findEndOfCentralDirectory(view: DataView) {
  const maxCommentLength = 0xffff;
  const minOffset = Math.max(0, view.byteLength - (maxCommentLength + 22));
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

async function inflateRaw(data: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress deflated ZIP entries. Try a current Chrome, Edge, or Safari build.');
  }

  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressGzip(data: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress gzip archives. Try a current Chrome, Edge, or Safari build.');
  }

  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractZip(file: UploadFile): Promise<UploadFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error('ZIP central directory was not found. The archive may be incomplete.');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let directoryOffset = view.getUint32(eocdOffset + 16, true);
  const extracted: UploadFile[] = [];
  const archiveRoot = fileName(file).replace(/\.[^.]+$/, '');

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(directoryOffset, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('ZIP central directory is corrupt.');
    }

    const compressionMethod = view.getUint16(directoryOffset + 10, true);
    const compressedSize = view.getUint32(directoryOffset + 20, true);
    const fileNameLength = view.getUint16(directoryOffset + 28, true);
    const extraLength = view.getUint16(directoryOffset + 30, true);
    const commentLength = view.getUint16(directoryOffset + 32, true);
    const localHeaderOffset = view.getUint32(directoryOffset + 42, true);
    const entryName = getString(bytes, directoryOffset + 46, fileNameLength);
    directoryOffset += 46 + fileNameLength + extraLength + commentLength;

    if (!entryName || entryName.endsWith('/') || entryName.includes('__MACOSX/')) continue;
    if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER) throw new Error(`${entryName}: ZIP local header is corrupt.`);

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const content = compressionMethod === 0 ? compressed : compressionMethod === 8 ? await inflateRaw(compressed) : null;
    if (!content) throw new Error(`${entryName}: ZIP compression method ${compressionMethod} is not supported.`);

    const path = `${archiveRoot}/${entryName}`.replace(/\/+/g, '/');
    extracted.push(withRelativePath(makeUploadFile(content, entryName.split('/').pop() || entryName), path));
  }

  return extracted;
}

function parseTarSize(value: string) {
  const parsed = Number.parseInt(value.replace(/\0.*$/, '').trim() || '0', 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractTarBytes(bytes: Uint8Array, sourceName: string) {
  const extracted: UploadFile[] = [];
  let offset = 0;
  const archiveRoot = sourceName.replace(/\.(tar|tgz|tar\.gz)$/i, '');

  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const name = getString(bytes, offset, 100);
    if (!name) break;

    const prefix = getString(bytes, offset + 345, 155);
    const typeFlag = getString(bytes, offset + 156, 1);
    const size = parseTarSize(getString(bytes, offset + 124, 12));
    const path = [prefix, name].filter(Boolean).join('/');
    const dataOffset = offset + TAR_BLOCK_SIZE;

    if (typeFlag !== '5' && size > 0) {
      const content = bytes.slice(dataOffset, dataOffset + size);
      const relativePath = `${archiveRoot}/${path}`.replace(/\/+/g, '/');
      extracted.push(withRelativePath(makeUploadFile(content, path.split('/').pop() || path), relativePath));
    }

    offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return extracted;
}

async function extractGzip(file: UploadFile): Promise<UploadFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inflated = await decompressGzip(bytes);
  const sourceName = fileName(file);
  if (/\.(tar\.gz|tgz)$/i.test(sourceName)) return extractTarBytes(inflated, sourceName);

  const outputName = sourceName.replace(/\.gz$/i, '') || `${sourceName}.dicom`;
  return [withRelativePath(makeUploadFile(inflated, outputName.split('/').pop() || outputName), outputName)];
}

async function extractArchive(file: UploadFile): Promise<UploadFile[]> {
  if (isZip(file)) return extractZip(file);
  if (isGzip(file)) return extractGzip(file);
  if (isTar(file)) return extractTarBytes(new Uint8Array(await file.arrayBuffer()), fileName(file));
  return [file];
}

async function expandFile(file: UploadFile, depth: number): Promise<ArchiveFile[]> {
  if (!isArchive(file)) return [{ file, archiveCount: 0 }];
  if (depth >= MAX_ARCHIVE_DEPTH) throw new Error(`${fileName(file)}: nested archive limit reached.`);

  const extracted = await extractArchive(file);
  const nested = await Promise.all(extracted.map((entry) => expandFile(entry, depth + 1)));
  return nested.flat().map((entry) => ({ ...entry, archiveCount: entry.archiveCount + (depth === 0 ? 1 : 0) }));
}

export async function expandUploadFiles(files: UploadFile[]): Promise<ArchiveExpansionResult> {
  const expanded: UploadFile[] = [];
  const warnings: string[] = [];
  let archiveCount = 0;

  for (const file of files) {
    try {
      const results = await expandFile(file, 0);
      expanded.push(...results.map((result) => result.file));
      archiveCount += results.some((result) => result.archiveCount > 0) ? 1 : 0;
    } catch (error) {
      warnings.push(`${fileName(file)}: ${error instanceof Error ? error.message : 'Could not unpack archive.'}`);
    }

    if (expanded.length > MAX_EXPANDED_FILES) {
      warnings.push(`Stopped after ${MAX_EXPANDED_FILES.toLocaleString()} files to keep the browser responsive. Upload a smaller study if slices are missing.`);
      return { files: expanded.slice(0, MAX_EXPANDED_FILES), warnings, archiveCount };
    }
  }

  return { files: expanded, warnings, archiveCount };
}
