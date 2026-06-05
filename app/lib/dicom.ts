import dicomParser, { type DataSet } from 'dicom-parser';
import type { DicomSeries, DicomSlice } from './types';

const SUPPORTED_TRANSFER_SYNTAXES = new Set([
  '',
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.1.99',
  '1.2.840.10008.1.2.2',
]);

const text = (dataSet: DataSet, tag: string, fallback = '') => {
  try {
    return dataSet.string(tag)?.trim() || fallback;
  } catch {
    return fallback;
  }
};

const numberValue = (dataSet: DataSet, tag: string, fallback = 0) => {
  const raw = text(dataSet, tag);
  const parsed = Number.parseFloat(raw.split('\\')[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function detectPlane(orientation?: string, description = ''): DicomSlice['acquisitionPlane'] {
  const normalized = `${orientation ?? ''} ${description}`.toLowerCase();
  if (normalized.includes('sag')) return 'sagittal';
  if (normalized.includes('cor')) return 'coronal';
  if (normalized.includes('ax')) return 'axial';

  if (!orientation) return 'unknown';
  const values = orientation.split('\\').map(Number);
  if (values.length < 6 || values.some((value) => !Number.isFinite(value))) return 'unknown';
  const row = values.slice(0, 3);
  const col = values.slice(3, 6);
  const normal = [
    row[1] * col[2] - row[2] * col[1],
    row[2] * col[0] - row[0] * col[2],
    row[0] * col[1] - row[1] * col[0],
  ].map(Math.abs);
  const axis = normal.indexOf(Math.max(...normal));
  return axis === 0 ? 'sagittal' : axis === 1 ? 'coronal' : 'axial';
}

function getPixelArray(dataSet: DataSet, bytes: Uint8Array, rows: number, columns: number) {
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement) throw new Error('No pixel data found. This may be a DICOMDIR/index file rather than an image slice.');

  const transferSyntax = text(dataSet, 'x00020010');
  if (!SUPPORTED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    throw new Error(`Unsupported DICOM transfer syntax (${transferSyntax}). Export uncompressed Explicit/Implicit VR DICOM slices for browser upload.`);
  }

  const bitsAllocated = numberValue(dataSet, 'x00280100', 16);
  const pixelRepresentation = numberValue(dataSet, 'x00280103', 0);
  const samplesPerPixel = numberValue(dataSet, 'x00280002', 1);
  if (samplesPerPixel !== 1) throw new Error('Only single-channel grayscale MRI slices are supported in this viewer.');
  if (![8, 16].includes(bitsAllocated)) throw new Error(`Unsupported ${bitsAllocated}-bit pixel data. Export 8-bit or 16-bit uncompressed DICOM slices.`);

  const count = rows * columns;
  const start = pixelElement.dataOffset;
  const littleEndian = !text(dataSet, 'x00020010').includes('1.2.840.10008.1.2.2');
  const expectedBytes = count * (bitsAllocated <= 8 ? 1 : 2);
  if (pixelElement.length < expectedBytes) {
    throw new Error('Pixel data is shorter than expected for this slice. It may be compressed or truncated.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + start, pixelElement.length);
  const pixels = new Float32Array(count);

  if (bitsAllocated <= 8) {
    for (let index = 0; index < count; index += 1) {
      pixels[index] = pixelRepresentation === 1 ? view.getInt8(index) : view.getUint8(index);
    }
    return pixels;
  }

  for (let index = 0; index < count; index += 1) {
    const offset = index * 2;
    pixels[index] = pixelRepresentation === 1 ? view.getInt16(offset, littleEndian) : view.getUint16(offset, littleEndian);
  }
  return pixels;
}

function renderDataUrl(dataSet: DataSet, bytes: Uint8Array, rows: number, columns: number) {
  const pixels = getPixelArray(dataSet, bytes, rows, columns);
  const slope = numberValue(dataSet, 'x00281053', 1);
  const intercept = numberValue(dataSet, 'x00281052', 0);
  const windowCenter = numberValue(dataSet, 'x00281050', Number.NaN);
  const windowWidth = numberValue(dataSet, 'x00281051', Number.NaN);

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  if (Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && windowWidth > 1) {
    low = windowCenter - windowWidth / 2;
    high = windowCenter + windowWidth / 2;
  } else {
    for (const raw of pixels) {
      const value = raw * slope + intercept;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available.');
  const image = context.createImageData(columns, rows);
  const range = Math.max(high - low, 1);

  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index] * slope + intercept;
    const grayscale = Math.max(0, Math.min(255, Math.round(((value - low) / range) * 255)));
    const out = index * 4;
    image.data[out] = grayscale;
    image.data[out + 1] = grayscale;
    image.data[out + 2] = grayscale;
    image.data[out + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

export async function parseDicomFiles(files: File[]): Promise<{ series: DicomSeries[]; warnings: string[] }> {
  const slices: DicomSlice[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dataSet = dicomParser.parseDicom(bytes, { untilTag: undefined });
      const modality = text(dataSet, 'x00080060');
      const rows = numberValue(dataSet, 'x00280010');
      const columns = numberValue(dataSet, 'x00280011');
      if (modality && modality !== 'MR') warnings.push(`${file.name}: modality is ${modality}, not MR.`);
      if (!rows || !columns) throw new Error('Missing image dimensions.');

      const seriesDescription = text(dataSet, 'x0008103e', 'Untitled series');
      const sequenceName = text(dataSet, 'x00180024');
      const orientation = text(dataSet, 'x00200037');
      const seriesInstanceUID = text(dataSet, 'x0020000e', `series-${seriesDescription}`);

      slices.push({
        id: `${seriesInstanceUID}-${text(dataSet, 'x00200013', file.name)}`,
        fileName: file.name,
        rows,
        columns,
        instanceNumber: numberValue(dataSet, 'x00200013'),
        seriesInstanceUID,
        seriesDescription,
        sequenceName,
        imageOrientationPatient: orientation,
        imagePositionPatient: text(dataSet, 'x00200032'),
        sliceLocation: numberValue(dataSet, 'x00201041', Number.NaN),
        pixelSpacing: text(dataSet, 'x00280030'),
        windowCenter: numberValue(dataSet, 'x00281050', Number.NaN),
        windowWidth: numberValue(dataSet, 'x00281051', Number.NaN),
        modality,
        studyDescription: text(dataSet, 'x00081030'),
        bodyPartExamined: text(dataSet, 'x00180015'),
        acquisitionPlane: detectPlane(orientation, seriesDescription),
        canvasDataUrl: renderDataUrl(dataSet, bytes, rows, columns),
      });
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not parse DICOM file.'}`);
    }
  }

  const grouped = new Map<string, DicomSlice[]>();
  for (const slice of slices) {
    grouped.set(slice.seriesInstanceUID, [...(grouped.get(slice.seriesInstanceUID) ?? []), slice]);
  }

  const series = [...grouped.entries()].map(([id, groupedSlices]) => {
    const sorted = groupedSlices.sort((a, b) => {
      const locA = Number.isFinite(a.sliceLocation) ? a.sliceLocation ?? 0 : a.instanceNumber;
      const locB = Number.isFinite(b.sliceLocation) ? b.sliceLocation ?? 0 : b.instanceNumber;
      return locA - locB;
    });
    const first = sorted[0];
    return {
      id,
      description: first.seriesDescription,
      sequenceName: first.sequenceName,
      plane: first.acquisitionPlane,
      slices: sorted,
    } satisfies DicomSeries;
  });

  return { series, warnings };
}
