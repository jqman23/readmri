declare module 'dicom-parser' {
  export type Fragment = { offset: number; length: number; dataOffset: number };
  export type Element = { dataOffset: number; length: number; tag?: string; encapsulatedPixelData?: boolean; hadUndefinedLength?: boolean; basicOffsetTable?: number[]; fragments?: Fragment[] };
  export type DataSet = {
    elements: Record<string, Element>;
    uint16(tag: string, index?: number): number | undefined;
    int16(tag: string, index?: number): number | undefined;
    uint32(tag: string, index?: number): number | undefined;
    int32(tag: string, index?: number): number | undefined;
    float(tag: string, index?: number): number | undefined;
    double(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    intString(tag: string, index?: number): number | undefined;
    string(tag: string, index?: number): string | undefined;
    text(tag: string, index?: number): string | undefined;
  };
  function parseDicom(bytes: Uint8Array, options?: unknown): DataSet;
  function readEncapsulatedPixelData(dataSet: DataSet, pixelDataElement: Element, frame: number): Uint8Array;
  const dicomParser: { parseDicom: typeof parseDicom; readEncapsulatedPixelData: typeof readEncapsulatedPixelData };
  export default dicomParser;
}
