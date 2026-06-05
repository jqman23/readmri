export type Annotation = {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  label: string;
  note: string;
  color: string;
  sliceIndex: number;
  seriesId: string;
  source?: 'user' | 'ai';
};

export type DicomSlice = {
  id: string;
  fileName: string;
  rows: number;
  columns: number;
  instanceNumber: number;
  seriesInstanceUID: string;
  seriesDescription: string;
  sequenceName: string;
  imageOrientationPatient?: string;
  imagePositionPatient?: string;
  sliceLocation?: number;
  pixelSpacing?: string;
  windowCenter?: number;
  windowWidth?: number;
  modality: string;
  studyDescription: string;
  bodyPartExamined: string;
  acquisitionPlane: 'sagittal' | 'coronal' | 'axial' | 'unknown';
  canvasDataUrl: string;
};

export type DicomSeries = {
  id: string;
  description: string;
  sequenceName: string;
  plane: DicomSlice['acquisitionPlane'];
  slices: DicomSlice[];
};

export type AiImageReference = {
  seriesId: string;
  seriesDescription: string;
  sliceIndex: number;
  fileName: string;
  instanceNumber: number;
  label: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type AiFinding = {
  region: string;
  plainLanguage: string;
  whyItMatters: string;
  confidence: 'low' | 'medium' | 'high';
  suggestedFollowUp: string;
  references: AiImageReference[];
};

export type AiAnalysis = {
  summary: string;
  safetyNotice: string;
  structuresChecklist: string[];
  findings: AiFinding[];
  questionsForDoctor: string[];
  limitations: string[];
  referencedAnnotations: Annotation[];
};
