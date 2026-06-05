import dicomParser, { type DataSet } from 'dicom-parser';
import type { DicomSeries, DicomSlice } from './types';

const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
  '',
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.1.99',
  '1.2.840.10008.1.2.2',
]);

const RAW_PARSE_TRANSFER_SYNTAXES = [
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.2',
];

const NON_IMAGE_WARNING_LIMIT = 8;
const MAX_FRAMES_PER_DICOM_FILE = 500;

const TRANSFER_SYNTAX_NAMES: Record<string, string> = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-Lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
};

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

function transferSyntaxName(transferSyntax: string) {
  return TRANSFER_SYNTAX_NAMES[transferSyntax] ?? (transferSyntax || 'DICOM default transfer syntax');
}

const SOP_CLASS_NAMES: Record<string, string> = {
  '1.2.840.10008.1.3.10': 'Media Storage Directory / DICOMDIR',
  '1.2.840.10008.5.1.4.1.1.7': 'Secondary Capture Image',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.11.1': 'Grayscale Softcopy Presentation State',
  '1.2.840.10008.5.1.4.1.1.88.11': 'Basic Text SR',
  '1.2.840.10008.5.1.4.1.1.88.22': 'Enhanced SR',
  '1.2.840.10008.5.1.4.1.1.88.33': 'Comprehensive SR',
  '1.2.840.10008.5.1.4.1.1.104.1': 'Encapsulated PDF',
};

function sopClassName(sopClassUid: string) {
  return SOP_CLASS_NAMES[sopClassUid] ?? (sopClassUid || 'unknown DICOM object');
}

function parseDicomDataSet(bytes: Uint8Array) {
  try {
    return dicomParser.parseDicom(bytes, { untilTag: undefined });
  } catch (part10Error) {
    const rawErrors: unknown[] = [part10Error];

    for (const transferSyntax of RAW_PARSE_TRANSFER_SYNTAXES) {
      try {
        return dicomParser.parseDicom(bytes, { TransferSyntaxUID: transferSyntax, untilTag: undefined });
      } catch (rawError) {
        rawErrors.push(rawError);
      }
    }

    throw rawErrors[0];
  }
}

function describeNonImageDicom(dataSet: DataSet) {
  const modality = text(dataSet, 'x00080060', 'unknown modality');
  const sopClassUid = text(dataSet, 'x00080016') || text(dataSet, 'x00020002');
  const transferSyntax = text(dataSet, 'x00020010');
  const parts = [modality, sopClassName(sopClassUid)];
  if (transferSyntax) parts.push(transferSyntaxName(transferSyntax));
  return parts.filter(Boolean).join(' · ');
}

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

function getPixelElement(dataSet: DataSet) {
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement) throw new Error('No pixel data found. This may be a DICOMDIR/index file rather than an image slice.');
  return pixelElement;
}

function getPixelArray(dataSet: DataSet, bytes: Uint8Array, rows: number, columns: number, frameIndex = 0) {
  const pixelElement = getPixelElement(dataSet);
  const transferSyntax = text(dataSet, 'x00020010');
  if (!UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    throw new Error(`Compressed ${transferSyntaxName(transferSyntax)} pixel data needs a decoder.`);
  }

  const bitsAllocated = numberValue(dataSet, 'x00280100', 16);
  const pixelRepresentation = numberValue(dataSet, 'x00280103', 0);
  const samplesPerPixel = numberValue(dataSet, 'x00280002', 1);
  if (![1, 3].includes(samplesPerPixel)) throw new Error(`${samplesPerPixel}-channel DICOM images are not supported in this viewer.`);
  if (![8, 16].includes(bitsAllocated)) throw new Error(`Unsupported ${bitsAllocated}-bit pixel data.`);

  const count = rows * columns * samplesPerPixel;
  const start = pixelElement.dataOffset;
  const littleEndian = !transferSyntax.includes('1.2.840.10008.1.2.2');
  const expectedBytes = count * (bitsAllocated <= 8 ? 1 : 2);
  const frameOffset = frameIndex * expectedBytes;
  if (pixelElement.length < frameOffset + expectedBytes) {
    throw new Error(`Pixel data is shorter than expected for frame ${frameIndex + 1}. It may be compressed or truncated.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + start + frameOffset, expectedBytes);
  const pixels = new Float32Array(count);

  if (bitsAllocated <= 8) {
    for (let index = 0; index < count; index += 1) {
      pixels[index] = pixelRepresentation === 1 ? view.getInt8(index) : view.getUint8(index);
    }
    return { pixels, samplesPerPixel };
  }

  for (let index = 0; index < count; index += 1) {
    const offset = index * 2;
    pixels[index] = pixelRepresentation === 1 ? view.getInt16(offset, littleEndian) : view.getUint16(offset, littleEndian);
  }
  return { pixels, samplesPerPixel };
}

function windowRange(dataSet: DataSet, pixels: Float32Array, samplesPerPixel: number) {
  const slope = numberValue(dataSet, 'x00281053', 1);
  const intercept = numberValue(dataSet, 'x00281052', 0);
  const windowCenter = numberValue(dataSet, 'x00281050', Number.NaN);
  const windowWidth = numberValue(dataSet, 'x00281051', Number.NaN);

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  if (samplesPerPixel === 1 && Number.isFinite(windowCenter) && Number.isFinite(windowWidth) && windowWidth > 1) {
    low = windowCenter - windowWidth / 2;
    high = windowCenter + windowWidth / 2;
  } else {
    for (const raw of pixels) {
      const value = raw * slope + intercept;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }

  return { low, range: Math.max(high - low, 1), slope, intercept };
}

function renderUncompressedDataUrl(dataSet: DataSet, bytes: Uint8Array, rows: number, columns: number, frameIndex = 0) {
  const { pixels, samplesPerPixel } = getPixelArray(dataSet, bytes, rows, columns, frameIndex);
  const { low, range, slope, intercept } = windowRange(dataSet, pixels, samplesPerPixel);
  const photometricInterpretation = text(dataSet, 'x00280004').toUpperCase();

  const canvas = document.createElement('canvas');
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available.');
  const image = context.createImageData(columns, rows);

  for (let index = 0; index < rows * columns; index += 1) {
    const out = index * 4;

    if (samplesPerPixel === 3) {
      const input = index * 3;
      image.data[out] = Math.max(0, Math.min(255, pixels[input]));
      image.data[out + 1] = Math.max(0, Math.min(255, pixels[input + 1]));
      image.data[out + 2] = Math.max(0, Math.min(255, pixels[input + 2]));
      image.data[out + 3] = 255;
      continue;
    }

    const value = pixels[index] * slope + intercept;
    const normalized = Math.round(((value - low) / range) * 255);
    const grayscale = photometricInterpretation === 'MONOCHROME1' ? 255 - normalized : normalized;
    image.data[out] = Math.max(0, Math.min(255, grayscale));
    image.data[out + 1] = Math.max(0, Math.min(255, grayscale));
    image.data[out + 2] = Math.max(0, Math.min(255, grayscale));
    image.data[out + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeRleSegment(frame: Uint8Array, offset: number, end: number, expectedLength: number) {
  const output = new Uint8Array(expectedLength);
  let input = offset;
  let out = 0;

  while (input < end && out < expectedLength) {
    const header = new Int8Array(frame.buffer, frame.byteOffset + input, 1)[0];
    input += 1;

    if (header >= 0) {
      const count = header + 1;
      output.set(frame.slice(input, input + count), out);
      input += count;
      out += count;
    } else if (header >= -127) {
      const count = 1 - header;
      output.fill(frame[input], out, out + count);
      input += 1;
      out += count;
    }
  }

  if (out < expectedLength) throw new Error('RLE segment ended before the image was fully decoded.');
  return output;
}

function decodeRlePixels(dataSet: DataSet, rows: number, columns: number, frameIndex = 0) {
  const pixelElement = getPixelElement(dataSet);
  const frame = dicomParser.readEncapsulatedPixelData(dataSet, pixelElement, frameIndex);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segmentCount = view.getUint32(0, true);
  const bitsAllocated = numberValue(dataSet, 'x00280100', 16);
  const pixelRepresentation = numberValue(dataSet, 'x00280103', 0);
  const samplesPerPixel = numberValue(dataSet, 'x00280002', 1);
  const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;
  const samples = rows * columns * samplesPerPixel;
  const segmentLength = rows * columns;
  const neededSegments = samplesPerPixel * bytesPerSample;

  if (![8, 16].includes(bitsAllocated)) throw new Error(`Unsupported ${bitsAllocated}-bit RLE pixel data.`);
  if (segmentCount < neededSegments) throw new Error('RLE image does not contain enough segments for its pixel format.');

  const segments = Array.from({ length: neededSegments }, (_, index) => {
    const offset = view.getUint32(4 + index * 4, true);
    const nextOffset = index + 1 < segmentCount ? view.getUint32(4 + (index + 1) * 4, true) : frame.byteLength;
    return decodeRleSegment(frame, offset, nextOffset, segmentLength);
  });

  const pixels = new Float32Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    const pixelIndex = sample % segmentLength;
    const samplePlane = Math.floor(sample / segmentLength);
    const segmentBase = samplePlane * bytesPerSample;
    let value = 0;

    for (let byteIndex = 0; byteIndex < bytesPerSample; byteIndex += 1) {
      value = (value << 8) | segments[segmentBase + byteIndex][pixelIndex];
    }

    if (pixelRepresentation === 1 && bitsAllocated === 16 && value > 0x7fff) value -= 0x10000;
    if (pixelRepresentation === 1 && bitsAllocated === 8 && value > 0x7f) value -= 0x100;
    pixels[sample] = value;
  }

  return { pixels, samplesPerPixel };
}

function renderRleDataUrl(dataSet: DataSet, rows: number, columns: number, frameIndex = 0) {
  const { pixels, samplesPerPixel } = decodeRlePixels(dataSet, rows, columns, frameIndex);
  const { low, range, slope, intercept } = windowRange(dataSet, pixels, samplesPerPixel);

  const canvas = document.createElement('canvas');
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available.');
  const image = context.createImageData(columns, rows);

  for (let index = 0; index < rows * columns; index += 1) {
    const out = index * 4;
    if (samplesPerPixel === 3) {
      const normalized = [pixels[index], pixels[index + rows * columns], pixels[index + rows * columns * 2]];
      image.data[out] = Math.max(0, Math.min(255, normalized[0]));
      image.data[out + 1] = Math.max(0, Math.min(255, normalized[1]));
      image.data[out + 2] = Math.max(0, Math.min(255, normalized[2]));
      image.data[out + 3] = 255;
      continue;
    }

    const value = pixels[index] * slope + intercept;
    const grayscale = Math.max(0, Math.min(255, Math.round(((value - low) / range) * 255)));
    image.data[out] = grayscale;
    image.data[out + 1] = grayscale;
    image.data[out + 2] = grayscale;
    image.data[out + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function encodedMimeTypes(transferSyntax: string) {
  if (transferSyntax.startsWith('1.2.840.10008.1.2.4.9')) return ['image/jp2', 'image/jpx', 'image/j2k'];
  if (transferSyntax.startsWith('1.2.840.10008.1.2.4.8')) return ['image/jls', 'image/jpeg'];
  return ['image/jpeg'];
}

async function renderEncodedImageDataUrl(dataSet: DataSet, rows: number, columns: number, transferSyntax: string, frameIndex = 0) {
  const pixelElement = getPixelElement(dataSet);
  const frame = dicomParser.readEncapsulatedPixelData(dataSet, pixelElement, frameIndex);
  let lastError: unknown;

  for (const mimeType of encodedMimeTypes(transferSyntax)) {
    try {
      const bitmap = await createImageBitmap(new Blob([toArrayBuffer(frame)], { type: mimeType }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width || columns;
      canvas.height = bitmap.height || rows;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is not available.');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return canvas.toDataURL('image/png');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Browser could not decode encapsulated image data.');
}

function renderPlaceholderDataUrl(rows: number, columns: number, title: string, details: string) {
  const width = Math.max(columns || 512, 512);
  const height = Math.max(rows || 512, 512);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available.');

  context.fillStyle = '#111827';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#38bdf8';
  context.lineWidth = 4;
  context.strokeRect(16, 16, width - 32, height - 32);
  context.fillStyle = '#e5e7eb';
  context.font = '700 28px sans-serif';
  context.textAlign = 'center';
  context.fillText(title, width / 2, height / 2 - 24);
  context.fillStyle = '#cbd5e1';
  context.font = '18px sans-serif';
  for (const [index, line] of details.match(/.{1,58}(\s|$)/g)?.slice(0, 4).entries() ?? []) {
    context.fillText(line.trim(), width / 2, height / 2 + 16 + index * 28);
  }

  return canvas.toDataURL('image/png');
}

async function renderDataUrl(dataSet: DataSet, bytes: Uint8Array, rows: number, columns: number, frameIndex = 0) {
  const transferSyntax = text(dataSet, 'x00020010');
  if (UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    return { dataUrl: renderUncompressedDataUrl(dataSet, bytes, rows, columns, frameIndex) };
  }

  try {
    const dataUrl = transferSyntax === '1.2.840.10008.1.2.5'
      ? renderRleDataUrl(dataSet, rows, columns, frameIndex)
      : await renderEncodedImageDataUrl(dataSet, rows, columns, transferSyntax, frameIndex);
    return { dataUrl, warning: `${transferSyntaxName(transferSyntax)} compressed DICOM decoded in the browser.` };
  } catch (error) {
    const syntax = transferSyntaxName(transferSyntax);
    const reason = error instanceof Error ? error.message : 'No browser decoder is available for this transfer syntax.';
    return {
      dataUrl: renderPlaceholderDataUrl(rows, columns, 'Compressed DICOM loaded', `${syntax}. Preview unavailable here, but the DICOM metadata was accepted.`),
      warning: `${syntax}: metadata loaded, but pixel preview could not be decoded by this browser (${reason}).`,
    };
  }
}

export async function parseDicomFiles(files: File[]): Promise<{ series: DicomSeries[]; warnings: string[] }> {
  const slices: DicomSlice[] = [];
  const warnings: string[] = [];
  let skippedNonImageDicom = 0;

  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dataSet = parseDicomDataSet(bytes);
      const modality = text(dataSet, 'x00080060');
      const rows = numberValue(dataSet, 'x00280010');
      const columns = numberValue(dataSet, 'x00280011');
      if (modality && modality !== 'MR') warnings.push(`${file.name}: modality is ${modality}, not MR.`);
      if (!rows || !columns || !dataSet.elements.x7fe00010) {
        skippedNonImageDicom += 1;
        if (skippedNonImageDicom <= NON_IMAGE_WARNING_LIMIT) {
          warnings.push(`${file.name}: skipped non-image DICOM object (${describeNonImageDicom(dataSet)}).`);
        }
        continue;
      }

      const seriesDescription = text(dataSet, 'x0008103e', 'Untitled series');
      const sequenceName = text(dataSet, 'x00180024');
      const orientation = text(dataSet, 'x00200037');
      const baseSeriesInstanceUID = text(dataSet, 'x0020000e', `series-${seriesDescription}`);
      const dicomFrameCount = Math.max(1, Math.floor(numberValue(dataSet, 'x00280008', 1)));
      const frameCount = Math.min(dicomFrameCount, MAX_FRAMES_PER_DICOM_FILE);
      if (dicomFrameCount > MAX_FRAMES_PER_DICOM_FILE) {
        warnings.push(`${file.name}: contains ${dicomFrameCount.toLocaleString()} frames; imported the first ${MAX_FRAMES_PER_DICOM_FILE.toLocaleString()} to keep the browser responsive.`);
      }

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const rendered = await renderDataUrl(dataSet, bytes, rows, columns, frameIndex);
        if (rendered.warning && frameIndex === 0) warnings.push(`${file.name}: ${rendered.warning}`);

        const frameSuffix = frameCount > 1 ? ` frame ${frameIndex + 1}` : '';
        const seriesInstanceUID = frameCount > 1 ? `${baseSeriesInstanceUID}-multiframe` : baseSeriesInstanceUID;
        const baseInstanceNumber = numberValue(dataSet, 'x00200013', 1);

        slices.push({
          id: `${seriesInstanceUID}-${baseInstanceNumber}-${frameIndex + 1}`,
          fileName: `${file.name}${frameSuffix}`,
          rows,
          columns,
          instanceNumber: baseInstanceNumber + frameIndex,
          seriesInstanceUID,
          seriesDescription,
          sequenceName,
          imageOrientationPatient: orientation,
          imagePositionPatient: text(dataSet, 'x00200032'),
          sliceLocation: Number.isFinite(numberValue(dataSet, 'x00201041', Number.NaN)) ? numberValue(dataSet, 'x00201041', Number.NaN) + frameIndex : frameIndex,
          pixelSpacing: text(dataSet, 'x00280030'),
          windowCenter: numberValue(dataSet, 'x00281050', Number.NaN),
          windowWidth: numberValue(dataSet, 'x00281051', Number.NaN),
          modality,
          studyDescription: text(dataSet, 'x00081030'),
          bodyPartExamined: text(dataSet, 'x00180015'),
          acquisitionPlane: detectPlane(orientation, seriesDescription),
          canvasDataUrl: rendered.dataUrl,
        });
      }
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not parse DICOM file.'}`);
    }
  }

  if (skippedNonImageDicom > NON_IMAGE_WARNING_LIMIT) {
    warnings.push(`Skipped ${skippedNonImageDicom - NON_IMAGE_WARNING_LIMIT} additional non-image DICOM object${skippedNonImageDicom - NON_IMAGE_WARNING_LIMIT === 1 ? '' : 's'} such as DICOMDIR, reports, presentation states, or encapsulated documents.`);
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
