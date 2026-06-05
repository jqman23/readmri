import type { DicomSeries, DicomSlice } from './types';
import type { UploadFile } from './upload';

function makeImageSeriesId(fileCount: number) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `image-export-${fileCount}-${random}`;
}

function uploadPath(file: UploadFile) {
  return file.webkitRelativePath || file.name;
}

function naturalCompare(a: UploadFile, b: UploadFile) {
  return uploadPath(a).localeCompare(uploadPath(b), undefined, { numeric: true, sensitivity: 'base' });
}

async function loadBitmap(file: File) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function captureImageDataUrl(image: ImageBitmap | HTMLImageElement) {
  const width = image.width;
  const height = image.height;
  if (!width || !height) throw new Error('Image file did not report usable dimensions.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available.');
  context.drawImage(image, 0, 0, width, height);
  if ('close' in image) image.close();

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

export async function parseImageFiles(files: UploadFile[]): Promise<{ series: DicomSeries[]; warnings: string[] }> {
  const warnings: string[] = [];
  const seriesId = makeImageSeriesId(files.length);
  const sortedFiles = [...files].sort(naturalCompare);
  const slices: DicomSlice[] = [];

  for (const [index, file] of sortedFiles.entries()) {
    try {
      const bitmap = await loadBitmap(file);
      const { dataUrl, width, height } = captureImageDataUrl(bitmap);
      const relativePath = uploadPath(file);

      slices.push({
        id: `${seriesId}-image-${index + 1}`,
        fileName: relativePath,
        rows: height,
        columns: width,
        instanceNumber: index + 1,
        seriesInstanceUID: seriesId,
        seriesDescription: 'Uploaded image export',
        sequenceName: 'PNG/JPEG image import',
        sliceLocation: index,
        pixelSpacing: '',
        windowCenter: Number.NaN,
        windowWidth: Number.NaN,
        modality: 'IMAGE',
        studyDescription: 'Image-derived sequence',
        bodyPartExamined: '',
        acquisitionPlane: 'unknown',
        canvasDataUrl: dataUrl,
      });
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not import image file.'}`);
    }
  }

  if (!slices.length) return { series: [], warnings };

  return {
    series: [{
      id: seriesId,
      description: 'Uploaded image export',
      sequenceName: `${slices.length} image${slices.length === 1 ? '' : 's'}`,
      plane: 'unknown',
      slices,
    }],
    warnings,
  };
}
