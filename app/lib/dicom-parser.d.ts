declare module 'dicom-parser' {
  export type Element = { dataOffset: number; length: number };
  export type DataSet = {
    elements: Record<string, Element>;
    string(tag: string): string | undefined;
  };
  function parseDicom(bytes: Uint8Array, options?: unknown): DataSet;
  const dicomParser: { parseDicom: typeof parseDicom };
  export default dicomParser;
}
