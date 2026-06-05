declare module 'dicom-parser' {
  export type Fragment = { offset: number; length: number; dataOffset: number };
  export type Element = { dataOffset: number; length: number; tag?: string; encapsulatedPixelData?: boolean; hadUndefinedLength?: boolean; basicOffsetTable?: number[]; fragments?: Fragment[] };
  export type DataSet = {
    elements: Record<string, Element>;
    string(tag: string): string | undefined;
  };
  function parseDicom(bytes: Uint8Array, options?: unknown): DataSet;
  function readEncapsulatedPixelData(dataSet: DataSet, pixelDataElement: Element, frame: number): Uint8Array;
  const dicomParser: { parseDicom: typeof parseDicom; readEncapsulatedPixelData: typeof readEncapsulatedPixelData };
  export default dicomParser;
}
