'use client';

import type { ChangeEvent, DragEvent, MouseEvent, PointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ankleChecklist, patientFriendlyGlossary } from '../lib/ankleKnowledge';
import { expandUploadFiles } from '../lib/archives';
import { clearPersistedWorkspace, loadPersistedWorkspace, savePersistedWorkspace } from '../lib/browserStorage';
import { parseDicomFiles } from '../lib/dicom';
import { parseImageFiles } from '../lib/image';
import { parseVideoFiles, type VideoFrameOptions } from '../lib/video';
import { describeFiles, getDicomCandidateFiles, getFilesFromDataTransfer, isImageFile, isVideoFile, type UploadFile } from '../lib/upload';
import type { AiAnalysis, AiChatMessage, AiImageReference, Annotation, DicomSeries, DicomSlice } from '../lib/types';

const annotationColors = ['#38bdf8', '#f97316', '#a3e635', '#f472b6', '#facc15'];
const AI_COLOR = '#facc15';
const MAX_AI_IMAGE_SIDE = 768;
const AI_IMAGE_JPEG_QUALITY = 0.82;
const SCOUT_MAX_CANDIDATES = 20;
const SCOUT_BATCH_SIZE = 5;

const exampleQuestions = [
  'Explain this slice in plain English and tell me what anatomy I am looking at.',
  'Help me find the best series and slice range for the painful area I describe.',
  'Scout the whole study for slices that might help me understand the deltoid ligament region.',
  'What should I ask my clinician about this area and what are the limits of this image?',
];

function promptVideoFrameOptions(videoCount: number): VideoFrameOptions {
  const frameCountInput = window.prompt(
    `${videoCount} video file${videoCount === 1 ? '' : 's'} selected. How many frames/slices should ReadMRI extract?`,
    '50',
  );
  if (frameCountInput === null) throw new Error('Video import canceled.');

  const fpsInput = window.prompt('What FPS should ReadMRI use to step through the video?', '20');
  if (fpsInput === null) throw new Error('Video import canceled.');

  const frameCount = Number.parseInt(frameCountInput, 10);
  const fps = Number.parseFloat(fpsInput);
  if (!Number.isFinite(frameCount) || frameCount < 1) throw new Error('Video frame count must be a positive whole number.');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Video FPS must be a positive number.');

  return { frameCount, fps };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (!text.trim()) return {};

  if (!contentType.includes('application/json')) {
    throw new Error(response.ok
      ? 'The AI service returned a non-JSON response.'
      : `The AI service returned ${response.status} ${response.statusText || 'error'} instead of JSON. ${text.slice(0, 180)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI service returned malformed JSON. Please try again; if it keeps happening, check the server logs and configured AI model.');
  }
}

function getAnalyzeError(json: unknown): string {
  if (json && typeof json === 'object' && 'error' in json) {
    const error = (json as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (error) return JSON.stringify(error);
  }

  return 'AI analysis failed.';
}

function getAnalyzeResult(json: unknown): AiAnalysis {
  if (json && typeof json === 'object' && 'analysis' in json) {
    return (json as { analysis: AiAnalysis }).analysis;
  }

  throw new Error('The AI service response did not include an analysis result.');
}

async function makeAiImageDataUrl(sourceDataUrl: string): Promise<string> {
  const image = new Image();
  image.src = sourceDataUrl;
  await image.decode();

  const scale = Math.min(1, MAX_AI_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is not available for AI image preparation.');

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', AI_IMAGE_JPEG_QUALITY);
}

function createDefaultAnalysis(): AiAnalysis {
  return {
    summary: 'Upload one or more ankle/foot MRI series, pick specific series for AI review, ask a focused question, and use image-linked answers for patient-friendly education.',
    safetyNotice: 'This app is educational and cannot diagnose. Always rely on your radiology report and a licensed clinician.',
    structuresChecklist: ankleChecklist,
    findings: [],
    questionsForDoctor: [
      'Which finding best explains my symptoms?',
      'Is this acute injury, overuse, arthritis, or an incidental finding?',
      'What activities should I avoid while waiting for follow-up?',
    ],
    limitations: ['No MRI has been analyzed yet.'],
    referencedAnnotations: [],
  };
}

function referenceLabel(reference: AiImageReference) {
  return `${reference.seriesDescription} · slice ${reference.sliceIndex + 1} · ${reference.fileName}`;
}

type ScoutCandidate = {
  series: DicomSeries;
  slice: DicomSlice;
  sliceIndex: number;
  score: number;
  reason: string;
};

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function scoreSeriesForQuestion(item: DicomSeries, question: string) {
  const haystack = `${item.description} ${item.sequenceName} ${item.plane}`.toLowerCase();
  const lowerQuestion = question.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (includesAny(haystack, ['t2', 'stir', 'fs', 'fat sat', 'fatsat', 'pd'])) {
    score += 5;
    reasons.push('fluid-sensitive sequence');
  }
  if (includesAny(haystack, ['cor', 'coronal']) || item.plane === 'coronal') {
    score += 4;
    reasons.push('coronal plane');
  }
  if (includesAny(haystack, ['ax', 'axial']) || item.plane === 'axial') {
    score += 3;
    reasons.push('axial plane');
  }
  if (includesAny(haystack, ['sag', 'sagittal']) || item.plane === 'sagittal') {
    score += 1;
    reasons.push('sagittal backup view');
  }
  if (includesAny(haystack, ['ankle', 'foot'])) {
    score += 2;
    reasons.push('ankle/foot labeled');
  }
  if (includesAny(lowerQuestion, ['deltoid', 'medial', 'spring ligament'])) {
    if (item.plane === 'coronal' || includesAny(haystack, ['cor', 'coronal'])) score += 4;
    if (item.plane === 'axial' || includesAny(haystack, ['ax', 'axial'])) score += 2;
    reasons.push('question mentions medial/deltoid region');
  }

  return { score, reason: reasons.length ? Array.from(new Set(reasons)).join(', ') : 'metadata fallback sample' };
}

function sampleSliceIndexes(sliceCount: number, desiredCount: number) {
  if (sliceCount <= 0 || desiredCount <= 0) return [];
  if (sliceCount <= desiredCount) return Array.from({ length: sliceCount }, (_, index) => index);

  const margin = sliceCount > 8 ? 2 : 0;
  const start = margin;
  const end = sliceCount - 1 - margin;
  const indexes = new Set<number>();
  for (let index = 0; index < desiredCount; index += 1) {
    const ratio = desiredCount === 1 ? 0.5 : index / (desiredCount - 1);
    indexes.add(Math.min(sliceCount - 1, Math.max(0, Math.round(start + (end - start) * ratio))));
  }

  return Array.from(indexes).sort((a, b) => a - b);
}

function buildScoutCandidates(allSeries: DicomSeries[], selectedIds: string[], question: string): ScoutCandidate[] {
  const selectedSeries = allSeries.filter((item) => selectedIds.includes(item.id));
  const scopedSeries = selectedSeries.length ? selectedSeries : allSeries;
  const scoredSeries = scopedSeries
    .map((item) => ({ ...scoreSeriesForQuestion(item, question), series: item }))
    .sort((a, b) => b.score - a.score || b.series.slices.length - a.series.slices.length);

  const topSeries = scoredSeries.slice(0, Math.min(4, scoredSeries.length));
  const perSeriesCount = Math.max(2, Math.ceil(SCOUT_MAX_CANDIDATES / Math.max(1, topSeries.length)));

  return topSeries.flatMap((item) => sampleSliceIndexes(item.series.slices.length, perSeriesCount).map((candidateIndex) => ({
    series: item.series,
    slice: item.series.slices[candidateIndex],
    sliceIndex: candidateIndex,
    score: item.score,
    reason: item.reason,
  }))).slice(0, SCOUT_MAX_CANDIDATES);
}

function chunkCandidates(candidates: ScoutCandidate[], chunkSize: number) {
  const chunks: ScoutCandidate[][] = [];
  for (let index = 0; index < candidates.length; index += chunkSize) {
    chunks.push(candidates.slice(index, index + chunkSize));
  }
  return chunks;
}

export default function MriWorkspace() {
  const [series, setSeries] = useState<DicomSeries[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState<string>('');
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState({ label: 'Area to ask about', note: '' });
  const [analysis, setAnalysis] = useState<AiAnalysis>(createDefaultAnalysis);
  const [userQuestion, setUserQuestion] = useState('What do you notice on this current frame, especially around my annotations?');
  const [aiChatHistory, setAiChatHistory] = useState<AiChatMessage[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [error, setError] = useState<string>('');
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [uploadSummary, setUploadSummary] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const draggedAnnotationIdRef = useRef<string | null>(null);
  const latestViewStateRef = useRef({ activeSeriesId: '', sliceIndex: 0 });

  const activeSeries = useMemo(
    () => series.find((item) => item.id === activeSeriesId) ?? series[0],
    [activeSeriesId, series],
  );
  const activeSlice = activeSeries?.slices[Math.min(sliceIndex, Math.max(activeSeries.slices.length - 1, 0))];
  const totalSlices = useMemo(() => series.reduce((total, item) => total + item.slices.length, 0), [series]);
  const userAnnotationCount = annotations.filter((annotation) => annotation.source !== 'ai').length;
  const visibleAnnotations = annotations.filter(
    (annotation) => annotation.seriesId === activeSeries?.id && annotation.sliceIndex === sliceIndex,
  );

  useEffect(() => {
    latestViewStateRef.current = { activeSeriesId: activeSeries?.id ?? activeSeriesId, sliceIndex };
  }, [activeSeries?.id, activeSeriesId, sliceIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return;
      if (!activeSeries) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setSliceIndex((current) => Math.max(current - 1, 0));
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setSliceIndex((current) => Math.min(current + 1, activeSeries.slices.length - 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSeries]);

  useEffect(() => {
    if (!activeSeries) return;
    [sliceIndex - 1, sliceIndex + 1]
      .filter((candidateIndex) => candidateIndex >= 0 && candidateIndex < activeSeries.slices.length)
      .forEach((candidateIndex) => {
        const image = new Image();
        image.src = activeSeries.slices[candidateIndex].canvasDataUrl;
      });
  }, [activeSeries, sliceIndex]);

  useEffect(() => {
    let canceled = false;

    loadPersistedWorkspace()
      .then((persisted) => {
        if (canceled || !persisted) return;
        setSeries(persisted.series);
        setAnnotations(persisted.annotations);
        setAnalysis(persisted.analysis);
        setActiveSeriesId(persisted.activeSeriesId || persisted.series[0]?.id || '');
        setSliceIndex(persisted.sliceIndex ?? 0);
        setSelectedSeriesIds(persisted.selectedSeriesIds?.length ? persisted.selectedSeriesIds : persisted.series.map((item) => item.id));
        setUploadSummary(persisted.uploadSummary);
        setUserQuestion(persisted.userQuestion || 'What do you notice on this current frame, especially around my annotations?');
        setAiChatHistory(persisted.aiChatHistory ?? []);
        setStorageMessage(`Restored ${persisted.series.length} locally saved series from this browser.`);
      })
      .catch((storageError) => setWarnings((existing) => [...existing, storageError instanceof Error ? storageError.message : 'Unable to restore local browser storage.']))
      .finally(() => {
        if (!canceled) {
          setIsRestoring(false);
          setIsHydrated(true);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    const timeoutId = window.setTimeout(() => {
      const latestViewState = latestViewStateRef.current;
      savePersistedWorkspace({
        series,
        annotations,
        analysis,
        activeSeriesId: latestViewState.activeSeriesId,
        sliceIndex: latestViewState.sliceIndex,
        selectedSeriesIds,
        uploadSummary,
        userQuestion,
        aiChatHistory,
        savedAt: new Date().toISOString(),
      }).catch((storageError) => setWarnings((existing) => [...existing, storageError instanceof Error ? storageError.message : 'Unable to save this study in local browser storage.']));
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [aiChatHistory, analysis, annotations, isHydrated, selectedSeriesIds, series, uploadSummary, userQuestion]);

  const loadFiles = async (incomingFiles: UploadFile[]) => {
    setIsParsing(true);
    setError('');
    setWarnings([]);

    try {
      const expanded = await expandUploadFiles(incomingFiles);
      const videoFiles = expanded.files.filter(isVideoFile);
      const imageFiles = expanded.files.filter(isImageFile);
      const dicomOrUnknownFiles = expanded.files.filter((file) => !isVideoFile(file) && !isImageFile(file));
      const { dicomCandidates, skippedNonDicom } = await getDicomCandidateFiles(dicomOrUnknownFiles);
      const { summary } = describeFiles(expanded.files, dicomCandidates.length, expanded.archiveCount, skippedNonDicom, videoFiles.length, imageFiles.length);
      setUploadSummary(summary);

      if (!dicomCandidates.length && !videoFiles.length && !imageFiles.length) {
        setWarnings(expanded.warnings);
        setError('No files were selected. Choose DICOM files, JPEG/PNG images, an MP4/video export, a folder/CD that contains MRI slices, or a .zip/.tar/.tgz/.gz archive.');
        return;
      }

      const videoOptions = videoFiles.length ? promptVideoFrameOptions(videoFiles.length) : null;
      const [dicomResult, imageResult, videoResult] = await Promise.all([
        dicomCandidates.length ? parseDicomFiles(dicomCandidates) : Promise.resolve({ series: [], warnings: [] }),
        imageFiles.length ? parseImageFiles(imageFiles) : Promise.resolve({ series: [], warnings: [] }),
        videoOptions ? parseVideoFiles(videoFiles, videoOptions) : Promise.resolve({ series: [], warnings: [] }),
      ]);
      const combinedSeries = [...dicomResult.series, ...imageResult.series, ...videoResult.series];
      const allWarnings = [...expanded.warnings, ...dicomResult.warnings, ...imageResult.warnings, ...videoResult.warnings];
      setSeries((existing) => [...existing, ...combinedSeries]);
      setWarnings(allWarnings);
      setActiveSeriesId((existing) => existing || combinedSeries[0]?.id || '');
      setSliceIndex(0);
      setSelectedSeriesIds((existing) => Array.from(new Set([...existing, ...combinedSeries.map((item) => item.id)])));
      setStorageMessage(combinedSeries.length ? 'Saved in local browser storage automatically. Refreshing this page will restore the loaded series.' : storageMessage);
      if (!combinedSeries.length) {
        setError(videoFiles.length && !dicomCandidates.length && !imageFiles.length
          ? 'No readable video frames were found. Try an MP4 file that your browser can play, then enter a positive frame count and FPS.'
          : 'No readable MRI slices were found. Select DICOM files, JPEG/PNG image exports, an MP4/video export, or upload the exported .zip/.tar/.tgz archive.');
      }
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Unable to parse those DICOM files.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    await loadFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const droppedFiles = await getFilesFromDataTransfer(event.dataTransfer);
    await loadFiles(droppedFiles);
  };

  const imageCoordinatesFromPointer = (clientX: number, clientY: number) => {
    if (!imageRef.current) return null;
    const bounds = imageRef.current.getBoundingClientRect();
    const x = ((clientX - bounds.left) / bounds.width) * 100;
    const y = ((clientY - bounds.top) / bounds.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return null;
    return { x, y };
  };

  const addAnnotation = (event: MouseEvent<HTMLDivElement>) => {
    if (!activeSlice || !activeSeries) return;
    const coordinates = imageCoordinatesFromPointer(event.clientX, event.clientY);
    if (!coordinates) return;
    setAnnotations((existing) => [
      ...existing,
      {
        id: crypto.randomUUID(),
        x: coordinates.x,
        y: coordinates.y,
        label: annotationDraft.label || 'Annotation',
        note: annotationDraft.note,
        color: annotationColors[existing.length % annotationColors.length],
        sliceIndex,
        seriesId: activeSeries.id,
        source: 'user',
      },
    ]);
  };

  const moveAnnotation = (annotationId: string, clientX: number, clientY: number) => {
    const coordinates = imageCoordinatesFromPointer(clientX, clientY);
    if (!coordinates) return;
    setAnnotations((existing) => existing.map((annotation) => (annotation.id === annotationId ? { ...annotation, ...coordinates } : annotation)));
    setAnalysis((existing) => ({
      ...existing,
      referencedAnnotations: existing.referencedAnnotations.map((annotation) => (annotation.id === annotationId ? { ...annotation, ...coordinates } : annotation)),
    }));
  };

  const startMovingAnnotation = (event: PointerEvent<HTMLDivElement>, annotationId: string) => {
    event.preventDefault();
    event.stopPropagation();
    draggedAnnotationIdRef.current = annotationId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueMovingAnnotation = (event: PointerEvent<HTMLDivElement>, annotationId: string) => {
    if (draggedAnnotationIdRef.current !== annotationId) return;
    event.preventDefault();
    event.stopPropagation();
    moveAnnotation(annotationId, event.clientX, event.clientY);
  };

  const stopMovingAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggedAnnotationIdRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    draggedAnnotationIdRef.current = null;
  };

  const deleteAnnotation = (annotationId: string) => {
    setAnnotations((existing) => existing.filter((annotation) => annotation.id !== annotationId));
    setAnalysis((existing) => ({
      ...existing,
      referencedAnnotations: existing.referencedAnnotations.filter((annotation) => annotation.id !== annotationId),
    }));
  };

  const jumpToReference = (reference: Pick<AiImageReference, 'seriesId' | 'sliceIndex'>) => {
    setActiveSeriesId(reference.seriesId);
    setSliceIndex(reference.sliceIndex);
  };

  const goToPreviousSlice = () => setSliceIndex((current) => Math.max(current - 1, 0));
  const goToNextSlice = () => {
    if (!activeSeries) return;
    setSliceIndex((current) => Math.min(current + 1, activeSeries.slices.length - 1));
  };

  const resetWorkspace = async () => {
    await clearPersistedWorkspace();
    setSeries([]);
    setActiveSeriesId('');
    setSliceIndex(0);
    setSelectedSeriesIds([]);
    setAnnotations([]);
    setAnalysis(createDefaultAnalysis());
    setAnalysisStatus('');
    setAiChatHistory([]);
    setUploadSummary('');
    setStorageMessage('Cleared locally saved browser study data.');
  };

  const findSlice = (seriesId: string, targetSliceIndex: number): DicomSlice | undefined => series
    .find((item) => item.id === seriesId)
    ?.slices[targetSliceIndex];

  const selectedStudySeries = () => series.filter((item) => selectedSeriesIds.includes(item.id)).map((item) => ({
    id: item.id,
    description: item.description,
    sequenceName: item.sequenceName,
    plane: item.plane,
    sliceCount: item.slices.length,
  }));

  const requestAnalysis = async ({
    questionText,
    primarySeries,
    primarySlice,
    primarySliceIndex,
    contextCandidates,
    frameAnnotations,
  }: {
    questionText: string;
    primarySeries: DicomSeries;
    primarySlice: DicomSlice;
    primarySliceIndex: number;
    contextCandidates: Array<{ series: DicomSeries; slice: DicomSlice; sliceIndex: number; imageId: string }>;
    frameAnnotations: Annotation[];
  }) => {
    const contextFrames = await Promise.all(contextCandidates.slice(0, 4).map(async ({ series: contextSeries, slice, sliceIndex: contextSliceIndex, imageId }) => ({
      imageId,
      seriesId: contextSeries.id,
      seriesDescription: contextSeries.description,
      sliceIndex: contextSliceIndex,
      fileName: slice.fileName,
      instanceNumber: slice.instanceNumber,
      dataUrl: await makeAiImageDataUrl(slice.canvasDataUrl),
    })));

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: questionText,
        series: {
          id: primarySeries.id,
          description: primarySeries.description,
          sequenceName: primarySeries.sequenceName,
          plane: primarySeries.plane,
          sliceCount: primarySeries.slices.length,
          metadata: {
            bodyPartExamined: primarySlice.bodyPartExamined,
            studyDescription: primarySlice.studyDescription,
            pixelSpacing: primarySlice.pixelSpacing,
            windowCenter: primarySlice.windowCenter,
            windowWidth: primarySlice.windowWidth,
          },
        },
        annotations: frameAnnotations,
        studySeries: selectedStudySeries(),
        currentFrame: {
          imageId: 'current-frame',
          seriesId: primarySeries.id,
          seriesDescription: primarySeries.description,
          sliceIndex: primarySliceIndex,
          fileName: primarySlice.fileName,
          instanceNumber: primarySlice.instanceNumber,
          dataUrl: await makeAiImageDataUrl(primarySlice.canvasDataUrl),
        },
        contextFrames,
        chatHistory: aiChatHistory,
      }),
    });
    const json = await readJsonResponse(response);
    if (!response.ok) throw new Error(getAnalyzeError(json));
    return getAnalyzeResult(json);
  };

  const runAnalysis = async () => {
    if (!activeSeries || !activeSlice) return;
    setIsAnalyzing(true);
    setError('');
    setAnalysisStatus(`Sending current frame with adjacent-slice context: ${activeSeries.description} slice ${sliceIndex + 1}...`);

    const questionText = userQuestion.trim() || 'Explain this current MRI frame in plain language.';
    const userMessage: AiChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: questionText,
      createdAt: new Date().toISOString(),
      seriesId: activeSeries.id,
      sliceIndex,
    };

    try {
      const contextCandidates = [sliceIndex - 1, sliceIndex + 1]
        .filter((candidateIndex) => candidateIndex >= 0 && candidateIndex < activeSeries.slices.length)
        .map((candidateIndex) => ({
          series: activeSeries,
          slice: activeSeries.slices[candidateIndex],
          sliceIndex: candidateIndex,
          imageId: `context-slice-${candidateIndex}`,
        }));
      const frameAnnotations = annotations.filter((annotation) => annotation.seriesId === activeSeries.id && annotation.sliceIndex === sliceIndex);
      const nextAnalysis = await requestAnalysis({
        questionText,
        primarySeries: activeSeries,
        primarySlice: activeSlice,
        primarySliceIndex: sliceIndex,
        contextCandidates,
        frameAnnotations,
      });
      const normalizedAiAnnotations = (nextAnalysis.referencedAnnotations ?? []).map((annotation, index) => ({
        ...annotation,
        id: annotation.id || `ai-${Date.now()}-${index}`,
        color: annotation.color || AI_COLOR,
        source: 'ai' as const,
        seriesId: activeSeries.id,
        sliceIndex,
      }));
      const normalizedAnalysis = { ...nextAnalysis, referencedAnnotations: normalizedAiAnnotations };
      const assistantMessage: AiChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: normalizedAnalysis.summary,
        createdAt: new Date().toISOString(),
        seriesId: activeSeries.id,
        sliceIndex,
      };

      setAnalysis(normalizedAnalysis);
      setAiChatHistory((existing) => [...existing, userMessage, assistantMessage].slice(-24));
      setAnalysisStatus(normalizedAnalysis.limitations?.some((limitation) => limitation.includes('No configured AI model'))
        ? 'AI is not configured yet, so ReadMRI showed safe placeholder guidance instead of image interpretation.'
        : `AI answered using current frame ${activeSeries.description} slice ${sliceIndex + 1} plus adjacent-slice context when available.`);
      setAnnotations((existing) => [
        ...existing.filter((annotation) => !(annotation.source === 'ai' && annotation.seriesId === activeSeries.id && annotation.sliceIndex === sliceIndex)),
        ...normalizedAiAnnotations,
      ]);
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : 'AI analysis failed.';
      setError(message);
      setAnalysisStatus(`AI request failed: ${message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const runStudyScout = async () => {
    if (!series.length) return;
    setIsAnalyzing(true);
    setError('');
    const baseQuestion = userQuestion.trim() || 'Find the most useful images for my question.';
    const candidates = buildScoutCandidates(series, selectedSeriesIds, baseQuestion);
    if (!candidates.length) {
      setAnalysisStatus('No slices are available to scout yet.');
      setIsAnalyzing(false);
      return;
    }

    const userMessage: AiChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: `Study scout: ${baseQuestion}`,
      createdAt: new Date().toISOString(),
    };

    try {
      const batches = chunkCandidates(candidates, SCOUT_BATCH_SIZE);
      const batchAnalyses: AiAnalysis[] = [];
      for (const [batchIndex, batch] of batches.entries()) {
        const primary = batch[0];
        setAnalysisStatus(`Scout pass ${batchIndex + 1}/${batches.length}: reviewing ${batch.length} candidate slices chosen from series names/planes...`);
        const candidateList = batch.map((candidate, index) => `${index + 1}. ${candidate.series.description} (${candidate.series.plane}) slice ${candidate.sliceIndex + 1}/${candidate.series.slices.length}; metadata reason: ${candidate.reason}`).join('\n');
        const batchQuestion = [
          'Study scout mode: the user wants help narrowing a full MRI study to the most useful slices, not a diagnosis.',
          `User goal: ${baseQuestion}`,
          'These images were preselected by metadata/series names before vision review:',
          candidateList,
          'Look at the supplied images and rank which ones seem most worth opening next. Be curious and concrete: say “go to this series/slice” when an image appears useful, and say when a candidate is not useful.',
          'If the goal mentions deltoid ligament, prioritize medial ankle ligament anatomy, fluid-sensitive signal, thickening, discontinuity, edema-like brightness, or adjacent soft-tissue changes when visible.',
        ].join('\n');
        const analysisResult = await requestAnalysis({
          questionText: batchQuestion,
          primarySeries: primary.series,
          primarySlice: primary.slice,
          primarySliceIndex: primary.sliceIndex,
          contextCandidates: batch.slice(1).map((candidate, index) => ({
            series: candidate.series,
            slice: candidate.slice,
            sliceIndex: candidate.sliceIndex,
            imageId: `scout-${batchIndex}-${index + 1}`,
          })),
          frameAnnotations: [],
        });
        batchAnalyses.push(analysisResult);
      }

      const findings = batchAnalyses.flatMap((item) => item.findings ?? []).slice(0, 12);
      const firstReference = findings.flatMap((finding) => finding.references ?? [])[0] ?? {
        seriesId: candidates[0].series.id,
        seriesDescription: candidates[0].series.description,
        sliceIndex: candidates[0].sliceIndex,
        fileName: candidates[0].slice.fileName,
        instanceNumber: candidates[0].slice.instanceNumber,
        label: 'Top metadata-selected candidate',
      };
      const metadataNotes = candidates.slice(0, 8).map((candidate) => `${candidate.series.description} slice ${candidate.sliceIndex + 1}: ${candidate.reason}`);
      const scoutAnalysis: AiAnalysis = {
        summary: `Scout reviewed ${candidates.length} metadata-selected slices in ${batches.length} vision batch${batches.length === 1 ? '' : 'es'}. Start with ${firstReference.seriesDescription} slice ${firstReference.sliceIndex + 1}, then use the referenced-image buttons below to jump through the other promising candidates.`,
        safetyNotice: 'Exploration mode: AI can help you navigate and compare images from a report you already have, but it still cannot confirm or rule out a tear on its own.',
        structuresChecklist: ankleChecklist,
        findings: findings.length ? findings : [{
          region: 'Metadata-selected scout candidates',
          plainLanguage: 'The AI did not return ranked visual findings, so ReadMRI is showing the best metadata-based starting points instead.',
          whyItMatters: 'Fluid-sensitive coronal/axial ankle series are often more useful starting points for medial ligament questions than randomly scanning every slice.',
          confidence: 'low',
          suggestedFollowUp: 'Open these slices and compare them with the wording and image numbers in your radiology report.',
          references: candidates.slice(0, 8).map((candidate) => ({
            seriesId: candidate.series.id,
            seriesDescription: candidate.series.description,
            sliceIndex: candidate.sliceIndex,
            fileName: candidate.slice.fileName,
            instanceNumber: candidate.slice.instanceNumber,
            label: `${candidate.series.description} slice ${candidate.sliceIndex + 1}`,
          })),
        }],
        questionsForDoctor: [
          'Which sequence and image number best shows the deltoid ligament abnormality mentioned in my report?',
          'Does the inflammation/edema pattern suggest sprain, partial tear, or another medial ankle structure involvement?',
          'Which slice should I compare over time if I get follow-up imaging?',
        ],
        limitations: [
          `Scout mode reviewed ${candidates.length} of ${totalSlices} loaded slices, chosen by metadata and even spacing rather than every single image.`,
          'Series names, planes, and thumbnails can guide navigation, but they can miss a subtle finding outside the sampled slices.',
          ...metadataNotes,
        ],
        referencedAnnotations: [],
      };
      const assistantMessage: AiChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: scoutAnalysis.summary,
        createdAt: new Date().toISOString(),
        seriesId: firstReference.seriesId,
        sliceIndex: firstReference.sliceIndex,
      };

      setAnalysis(scoutAnalysis);
      setAiChatHistory((existing) => [...existing, userMessage, assistantMessage].slice(-24));
      setAnalysisStatus(`Scout complete: narrowed ${totalSlices} loaded slices to ${candidates.length} candidates and reviewed them in Groq-friendly batches of up to ${SCOUT_BATCH_SIZE}.`);
      jumpToReference(firstReference);
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : 'AI study scout failed.';
      setError(message);
      setAnalysisStatus(`Study scout failed: ${message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };


  return (
    <main className="shell">
      <section className="hero card">
        <div className="heroCopy">
          <p className="eyebrow">Ankle + foot MRI education workspace</p>
          <h1>A calmer way to explore your MRI before the appointment.</h1>
          <p className="lede">
            Upload a study, let AI scout the series names and candidate slices, then jump straight to images worth discussing with your clinician.
          </p>
          <div className="heroActions" aria-label="Suggested workflow">
            <a href="#upload-panel">1. Upload</a>
            <a href="#viewer-panel">2. Review slices</a>
            <a href="#ai-panel">3. Scout + ask AI</a>
          </div>
        </div>
        <div className="safety">
          <strong>Exploration partner — not a diagnosis.</strong>
          <span>Use ReadMRI to chase down report findings, compare slices, and organize better questions. Medical decisions still require your radiology report and licensed clinicians.</span>
        </div>
      </section>

      <section className="statusStrip card" aria-label="Study status">
        <div>
          <span className="statusLabel">Series loaded</span>
          <strong>{series.length}</strong>
        </div>
        <div>
          <span className="statusLabel">Slices ready</span>
          <strong>{totalSlices}</strong>
        </div>
        <div>
          <span className="statusLabel">Your notes</span>
          <strong>{userAnnotationCount}</strong>
        </div>
        <div>
          <span className="statusLabel">Local save</span>
          <strong>{isRestoring ? 'Checking' : isHydrated ? 'On' : 'Off'}</strong>
        </div>
      </section>

      <section className="grid">
        <aside id="upload-panel" className="card controls" aria-label="Upload and study controls">
          <div className="panelHeader">
            <p className="eyebrow">Step 1</p>
            <h2>Load your study</h2>
            <p className="hint">Drag in a portal download, MRI disc folder, archive, image export, or video export. Nothing leaves your browser until you ask AI.</p>
          </div>

          <label
            className={`upload${isDragOver ? ' dragOver' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <span>{isParsing ? 'Reading images…' : 'Drop MRI files here'}</span>
            <small>or click to select DICOM, image/video exports, or .zip/.tar/.tgz/.gz archives</small>
            <input type="file" multiple accept=".dcm,.dicom,.ima,.jpg,.jpeg,.png,.bmp,.gif,.webp,.mp4,.m4v,.mov,.webm,.zip,.tar,.tgz,.gz,application/dicom,image/jpeg,image/png,image/bmp,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/zip,application/gzip" onChange={handleFiles} />
          </label>
          <label className="folderUpload">
            Select an entire folder / mounted MRI CD
            <input
              type="file"
              multiple
              onChange={handleFiles}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
          </label>

          <div className="helperCard">
            <strong>Tip</strong>
            <span>If you are unsure what to upload, choose the whole exported folder or ZIP. ReadMRI will sort readable slices into series.</span>
          </div>

          {uploadSummary && <p className="hint uploadSummary">{uploadSummary}</p>}
          {(storageMessage || isRestoring) && <p className="hint uploadSummary">{isRestoring ? 'Checking local browser storage…' : storageMessage}</p>}

          <button className="secondary dangerAction" type="button" onClick={resetWorkspace} disabled={isParsing || isAnalyzing || (!series.length && !annotations.length)}>
            Clear local study
          </button>

          <div className="divider" />

          <div className="panelHeader compact">
            <p className="eyebrow">Step 2</p>
            <h2>Navigate</h2>
          </div>

          <div className="field">
            <label htmlFor="series-select">Series to view</label>
            <select
              id="series-select"
              value={activeSeries?.id ?? ''}
              onChange={(event) => {
                setActiveSeriesId(event.target.value);
                setSliceIndex(0);
              }}
            >
              {series.length === 0 && <option>No series loaded</option>}
              {series.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.description} · {item.plane} · {item.slices.length} slices
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <div className="fieldRow">
              <label htmlFor="slice-range">Slice {activeSeries ? `${sliceIndex + 1} of ${activeSeries.slices.length}` : ''}</label>
              <span className="keyboardHint">← / →</span>
            </div>
            <input
              id="slice-range"
              type="range"
              min="0"
              max={Math.max((activeSeries?.slices.length ?? 1) - 1, 0)}
              value={sliceIndex}
              onChange={(event) => setSliceIndex(Number(event.target.value))}
              disabled={!activeSeries}
            />
            <div className="sliceButtons">
              <button type="button" onClick={goToPreviousSlice} disabled={!activeSeries || sliceIndex === 0}>Previous</button>
              <button type="button" onClick={goToNextSlice} disabled={!activeSeries || sliceIndex >= (activeSeries.slices.length - 1)}>Next</button>
            </div>
          </div>

          {series.length > 0 && (
            <div className="seriesPicker">
              <div className="seriesPickerHeader">
                <strong>Include in AI study list</strong>
                <button type="button" onClick={() => setSelectedSeriesIds(series.map((item) => item.id))}>All</button>
                <button type="button" onClick={() => setSelectedSeriesIds(activeSeries ? [activeSeries.id] : [])}>Current</button>
              </div>
              {series.map((item) => (
                <label className="seriesCheck" key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedSeriesIds.includes(item.id)}
                    onChange={(event) => setSelectedSeriesIds((existing) => (event.target.checked ? [...existing, item.id] : existing.filter((id) => id !== item.id)))}
                  />
                  <span>{item.description}<small>{item.plane} · {item.slices.length} slices</small></span>
                </label>
              ))}
            </div>
          )}
        </aside>

        <section id="viewer-panel" className="card viewer" aria-label="MRI image viewer">
          {activeSlice ? (
            <>
              <div className="viewerHeader">
                <div>
                  <p className="eyebrow">Current frame</p>
                  <h2>{activeSeries?.description}</h2>
                  <p>{activeSeries?.plane} · {activeSeries?.sequenceName || 'sequence not labeled'} · {activeSlice.rows}×{activeSlice.columns}</p>
                </div>
                <span className="badge">Slice {sliceIndex + 1}: {activeSlice.fileName}</span>
              </div>
              <div className="imageStage" onClick={addAnnotation} role="button" tabIndex={0} aria-label="MRI slice annotation canvas. Click the image to add a note.">
                <img ref={imageRef} src={activeSlice.canvasDataUrl} alt="Rendered MRI slice" draggable={false} decoding="async" fetchPriority="high" />
                {visibleAnnotations.map((annotation) => (
                  <div
                    key={annotation.id}
                    className={`pin${annotation.source === 'ai' ? ' aiPin' : ''}`}
                    style={{
                      left: `${annotation.x}%`,
                      top: `${annotation.y}%`,
                      width: annotation.width ? `${annotation.width}%` : undefined,
                      height: annotation.height ? `${annotation.height}%` : undefined,
                      borderColor: annotation.color,
                    }}
                    title={annotation.note || 'Drag to move this annotation.'}
                    onPointerDown={(event) => startMovingAnnotation(event, annotation.id)}
                    onPointerMove={(event) => continueMovingAnnotation(event, annotation.id)}
                    onPointerUp={stopMovingAnnotation}
                    onPointerCancel={stopMovingAnnotation}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span style={{ background: annotation.color }}>{annotation.label}</span>
                  </div>
                ))}
              </div>
              <div className="viewerFooter">
                <span>Click the image to add your note.</span>
                <span>Drag labels to reposition.</span>
                <span>Use arrow keys to scan slices.</span>
              </div>
              {visibleAnnotations.length > 0 && (
                <div className="annotationList">
                  {visibleAnnotations.map((annotation) => (
                    <div className="annotationItem" key={annotation.id}>
                      <button type="button" onClick={() => jumpToReference({ seriesId: annotation.seriesId, sliceIndex: annotation.sliceIndex })}>
                        <strong>{annotation.source === 'ai' ? 'AI' : 'You'}: {annotation.label}</strong>
                        <small>{annotation.note || 'No note'} · slice {annotation.sliceIndex + 1}</small>
                      </button>
                      <button className="deleteAnnotation" type="button" onClick={() => deleteAnnotation(annotation.id)} aria-label={`Delete annotation ${annotation.label}`}>Delete</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              <div>
                <p className="eyebrow">No study loaded yet</p>
                <h2>Start by dropping your MRI export on the upload panel.</h2>
                <p>DICOM files, common image exports, videos, folders, CDs, and archives are supported.</p>
              </div>
            </div>
          )}
        </section>

        <aside id="ai-panel" className="card analysis" aria-label="AI explanation and notes">
          <div className="panelHeader">
            <p className="eyebrow">Step 3</p>
            <h2>Ask in plain language</h2>
            <p className="hint">AI can scout series names first, review a smaller set of candidate slices, then chat about the current frame like a curious study partner.</p>
          </div>
          <p className="notice">{analysis.safetyNotice}</p>

          <div className="currentFrameAi">
            <strong>Review scope</strong>
            <span>{activeSeries && activeSlice ? `${activeSeries.description} · slice ${sliceIndex + 1} · ${activeSlice.fileName}` : 'Upload and open a frame before asking AI.'}</span>
            <small>Use Scout first for “find where the report finding might be,” then use frame chat for a close look.</small>
          </div>

          <div className="field">
            <label htmlFor="annotation-label">Note label</label>
            <input id="annotation-label" value={annotationDraft.label} onChange={(event) => setAnnotationDraft({ ...annotationDraft, label: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="annotation-note">Question or note for the image</label>
            <textarea id="annotation-note" value={annotationDraft.note} onChange={(event) => setAnnotationDraft({ ...annotationDraft, note: event.target.value })} placeholder="Example: Is this tendon swollen?" />
          </div>

          <div className="field">
            <label htmlFor="ai-question">What do you want help with?</label>
            <textarea id="ai-question" value={userQuestion} onChange={(event) => setUserQuestion(event.target.value)} placeholder="Example: I care about the deltoid ligament. Is this a useful slice, or should I move before/after or switch series?" />
            <div className="quickPrompts">
              {exampleQuestions.map((prompt) => (
                <button key={prompt} type="button" onClick={() => setUserQuestion(prompt)}>{prompt}</button>
              ))}
            </div>
          </div>

          <div className="aiActionStack">
            <button className="primary" onClick={runStudyScout} disabled={!series.length || isAnalyzing}>
              {isAnalyzing ? 'AI is working…' : 'Scout study for useful slices'}
            </button>
            <button className="secondary" onClick={runAnalysis} disabled={!activeSlice || isAnalyzing}>
              {isAnalyzing ? 'Analyzing this frame…' : 'Ask AI about this frame'}
            </button>
          </div>
          {analysisStatus && <p className={error ? 'analysisStatus error' : 'analysisStatus'}>{analysisStatus}</p>}

          {aiChatHistory.length > 0 && (
            <div className="chatHistory">
              <div className="chatHistoryHeader">
                <h3>Recent frame chat</h3>
                <button type="button" onClick={() => setAiChatHistory([])}>Clear</button>
              </div>
              {aiChatHistory.slice(-6).map((message) => (
                <p key={message.id} className={`chatBubble ${message.role}`}>
                  <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                  <span>{message.text}</span>
                  {message.seriesId && typeof message.sliceIndex === 'number' && <small>Slice {message.sliceIndex + 1}</small>}
                </p>
              ))}
            </div>
          )}

          <div className="resultBlock">
            <h3>Summary</h3>
            <p>{analysis.summary}</p>
          </div>
          <div className="resultBlock">
            <h3>Possible findings / discussion points</h3>
            {analysis.findings.length ? analysis.findings.map((finding, findingIndex) => (
              <article className="finding" key={`${finding.region}-${findingIndex}`}>
                <strong>{finding.region} <span>{finding.confidence}</span></strong>
                <p>{finding.plainLanguage}</p>
                <small>{finding.whyItMatters} Follow-up: {finding.suggestedFollowUp}</small>
                {finding.references?.length > 0 && (
                  <div className="references">
                    <b>Referenced images</b>
                    {finding.references.map((reference) => (
                      <button key={`${findingIndex}-${reference.seriesId}-${reference.sliceIndex}-${reference.label}`} type="button" onClick={() => jumpToReference(reference)}>
                        {reference.label || referenceLabel(reference)}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            )) : <p className="muted">No AI findings yet. Open a frame, optionally mark an area, then ask about this image or ask which series/slice range to try next.</p>}
          </div>

          {analysis.referencedAnnotations?.length > 0 && (
            <div className="resultBlock">
              <h3>AI callouts</h3>
              <div className="references">
                {analysis.referencedAnnotations.map((annotation) => {
                  const slice = findSlice(annotation.seriesId, annotation.sliceIndex);
                  return (
                    <button key={annotation.id} type="button" onClick={() => jumpToReference(annotation)}>
                      {annotation.label}: slice {annotation.sliceIndex + 1}{slice ? ` · ${slice.fileName}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="resultBlock">
            <h3>Questions for your clinician</h3>
            <ul>{analysis.questionsForDoctor.map((question) => <li key={question}>{question}</li>)}</ul>
          </div>
          {analysis.limitations.length > 0 && (
            <div className="resultBlock">
              <h3>Limitations</h3>
              <ul>{analysis.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
            </div>
          )}
        </aside>
      </section>

      <section className="lowerGrid">
        <div className="card">
          <p className="eyebrow">Reference</p>
          <h2>Ankle MRI checklist</h2>
          <div className="checklist">{ankleChecklist.map((item) => <span key={item}>{item}</span>)}</div>
        </div>
        <div className="card">
          <p className="eyebrow">Reference</p>
          <h2>Plain-language glossary</h2>
          <div className="glossary">{patientFriendlyGlossary.map((item) => <p key={item.term}><strong>{item.term}:</strong> {item.explanation}</p>)}</div>
        </div>
      </section>

      {(warnings.length > 0 || error) && (
        <section className="card messages">
          <h2>Import and app messages</h2>
          {error && <p className="error">{error}</p>}
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </section>
      )}
    </main>
  );
}
