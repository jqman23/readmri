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
  const visibleAnnotations = annotations.filter(
    (annotation) => annotation.seriesId === activeSeries?.id && annotation.sliceIndex === sliceIndex,
  );

  useEffect(() => {
    latestViewStateRef.current = { activeSeriesId: activeSeries?.id ?? activeSeriesId, sliceIndex };
  }, [activeSeries?.id, activeSeriesId, sliceIndex]);

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
      const aiImageDataUrl = await makeAiImageDataUrl(activeSlice.canvasDataUrl);
      const contextSlices = [sliceIndex - 1, sliceIndex + 1]
        .filter((candidateIndex) => candidateIndex >= 0 && candidateIndex < activeSeries.slices.length)
        .map((candidateIndex) => ({ slice: activeSeries.slices[candidateIndex], sliceIndex: candidateIndex }));
      const contextFrames = await Promise.all(contextSlices.map(async ({ slice, sliceIndex: contextSliceIndex }) => ({
        imageId: `context-slice-${contextSliceIndex}`,
        seriesId: activeSeries.id,
        seriesDescription: activeSeries.description,
        sliceIndex: contextSliceIndex,
        fileName: slice.fileName,
        instanceNumber: slice.instanceNumber,
        dataUrl: await makeAiImageDataUrl(slice.canvasDataUrl),
      })));
      const frameAnnotations = annotations.filter((annotation) => annotation.seriesId === activeSeries.id && annotation.sliceIndex === sliceIndex);
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: questionText,
          series: {
            id: activeSeries.id,
            description: activeSeries.description,
            sequenceName: activeSeries.sequenceName,
            plane: activeSeries.plane,
            sliceCount: activeSeries.slices.length,
            metadata: {
              bodyPartExamined: activeSlice.bodyPartExamined,
              studyDescription: activeSlice.studyDescription,
              pixelSpacing: activeSlice.pixelSpacing,
              windowCenter: activeSlice.windowCenter,
              windowWidth: activeSlice.windowWidth,
            },
          },
          annotations: frameAnnotations,
          studySeries: series.map((item) => ({
            id: item.id,
            description: item.description,
            sequenceName: item.sequenceName,
            plane: item.plane,
            sliceCount: item.slices.length,
          })),
          currentFrame: {
            imageId: 'current-frame',
            seriesId: activeSeries.id,
            seriesDescription: activeSeries.description,
            sliceIndex,
            fileName: activeSlice.fileName,
            instanceNumber: activeSlice.instanceNumber,
            dataUrl: aiImageDataUrl,
          },
          contextFrames,
          chatHistory: aiChatHistory,
        }),
      });
      const json = await readJsonResponse(response);
      if (!response.ok) throw new Error(getAnalyzeError(json));
      const nextAnalysis = getAnalyzeResult(json);
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

  return (
    <main className="shell">
      <section className="hero card">
        <div>
          <p className="eyebrow">Ankle + foot MRI education workspace</p>
          <h1>ReadMRI helps non-experts explore multiple MRI series.</h1>
          <p className="lede">
            Import DICOM/image/video MRI data, view one slice at a time, mark the exact area you care about, and chat with AI that focuses on the active frame while using nearby slices and series metadata to guide where to look next.
          </p>
        </div>
        <div className="safety">
          <strong>Not a diagnosis.</strong>
          <span>Use this to understand anatomy and questions to ask. A radiologist and clinician must make medical decisions.</span>
        </div>
      </section>

      <section className="grid">
        <aside className="card controls">
          <label
            className={`upload${isDragOver ? ' dragOver' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <span>{isParsing ? 'Reading images…' : 'Upload more DICOM, images, MP4/video, folder, CD export, or archive'}</span>
            <small>Every upload is appended as additional series and saved locally in this browser with IndexedDB. Extensionless DICOM files, JPEG/PNG images, MP4 videos, and archives are accepted.</small>
            <input type="file" multiple accept=".dcm,.dicom,.ima,.jpg,.jpeg,.png,.bmp,.gif,.webp,.mp4,.m4v,.mov,.webm,.zip,.tar,.tgz,.gz,application/dicom,image/jpeg,image/png,image/bmp,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/zip,application/gzip" onChange={handleFiles} />
          </label>
          <label className="folderUpload">
            Select a DICOM/image folder or mounted CD
            <input
              type="file"
              multiple
              onChange={handleFiles}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
          </label>
          <button className="secondary" type="button" onClick={resetWorkspace} disabled={isParsing || isAnalyzing || (!series.length && !annotations.length)}>
            Clear local study
          </button>
          {uploadSummary && <p className="hint uploadSummary">{uploadSummary}</p>}
          {(storageMessage || isRestoring) && <p className="hint uploadSummary">{isRestoring ? 'Checking local browser storage…' : storageMessage}</p>}

          <div className="field">
            <label>View one series</label>
            <select
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
            <label>Slice {activeSeries ? `${sliceIndex + 1} / ${activeSeries.slices.length}` : ''}</label>
            <input
              type="range"
              min="0"
              max={Math.max((activeSeries?.slices.length ?? 1) - 1, 0)}
              value={sliceIndex}
              onChange={(event) => setSliceIndex(Number(event.target.value))}
              disabled={!activeSeries}
            />
          </div>

          <div className="currentFrameAi">
            <strong>AI vision scope: active frame + nearby context</strong>
            <span>{activeSeries && activeSlice ? `${activeSeries.description} · slice ${sliceIndex + 1} · ${activeSlice.fileName}` : 'Upload and open a frame before asking AI.'}</span>
            <small>AI focuses on the image you are viewing, can compare the slice just before/after, and can use the imported series list to suggest where to navigate next.</small>
          </div>

          <div className="field">
            <label>Chat with AI / ask where to look next</label>
            <textarea value={userQuestion} onChange={(event) => setUserQuestion(event.target.value)} placeholder="Example: I care about the deltoid ligament. Is this a useful slice, or should I move before/after or switch series?" />
            <div className="quickPrompts">
              <button type="button" onClick={() => setUserQuestion('I just imported the study. I want help finding the best series and slice range for the structure or symptom I mention. Based on the series list and current/adjacent frames, where should I go next?')}>Find best slice</button>
              <button type="button" onClick={() => setUserQuestion('Is this current slice good enough for the area I care about, or should I move a few slices before/after? Please be specific.')}>Is this slice good?</button>
            </div>
          </div>

          <div className="field">
            <label>Manual annotation label</label>
            <input value={annotationDraft.label} onChange={(event) => setAnnotationDraft({ ...annotationDraft, label: event.target.value })} />
          </div>
          <div className="field">
            <label>Manual question/note</label>
            <textarea value={annotationDraft.note} onChange={(event) => setAnnotationDraft({ ...annotationDraft, note: event.target.value })} placeholder="Example: Is this tendon swollen?" />
          </div>
          <button className="primary" onClick={runAnalysis} disabled={!activeSlice || isAnalyzing}>
            {isAnalyzing ? 'Analyzing frame + neighbors…' : 'Ask AI / get navigation help'}
          </button>
          <p className="hint">Click directly on the MRI image to drop an annotation first. You can also ask AI which series/slice range to try next, then navigate there and ask again.</p>
        </aside>

        <section className="card viewer">
          {activeSlice ? (
            <>
              <div className="viewerHeader">
                <div>
                  <h2>{activeSeries?.description}</h2>
                  <p>{activeSeries?.plane} · {activeSeries?.sequenceName || 'sequence not labeled'} · {activeSlice.rows}×{activeSlice.columns}</p>
                </div>
                <span className="badge">Slice {sliceIndex + 1}: {activeSlice.fileName}</span>
              </div>
              <div className="imageStage" onClick={addAnnotation} role="button" tabIndex={0} aria-label="MRI slice annotation canvas">
                <img ref={imageRef} src={activeSlice.canvasDataUrl} alt="Rendered DICOM MRI slice" draggable={false} decoding="async" fetchPriority="high" />
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
              {visibleAnnotations.length > 0 && (
                <div className="annotationList">
                  {visibleAnnotations.map((annotation) => (
                    <div className="annotationItem" key={annotation.id}>
                      <button type="button" onClick={() => jumpToReference({ seriesId: annotation.seriesId, sliceIndex: annotation.sliceIndex })}>
                        <strong>{annotation.source === 'ai' ? 'AI' : 'You'}: {annotation.label}</strong>
                        <small>{annotation.note || 'No note'} · Drag the label on the image to move it.</small>
                      </button>
                      <button className="deleteAnnotation" type="button" onClick={() => deleteAnnotation(annotation.id)} aria-label={`Delete annotation ${annotation.label}`}>Delete</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="empty">Upload individual DICOM files, JPEG/PNG image exports, an MP4/video export, drag a series folder/CD export, or pick a compressed .zip/.tar/.tgz archive from your MRI disc/export.</div>
          )}
        </section>

        <aside className="card analysis">
          <div className="sectionTitle">
            <p className="eyebrow">AI explanation</p>
            <h2>Guided frame chat</h2>
          </div>
          <p className="notice">{analysis.safetyNotice}</p>
          {analysisStatus && <p className={error ? 'analysisStatus error' : 'analysisStatus'}>{analysisStatus}</p>}
          {aiChatHistory.length > 0 && (
            <div className="chatHistory">
              <div className="chatHistoryHeader">
                <h3>Frame chat memory</h3>
                <button type="button" onClick={() => setAiChatHistory([])}>Clear chat</button>
              </div>
              {aiChatHistory.slice(-6).map((message) => (
                <p key={message.id} className={`chatBubble ${message.role}`}>
                  <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                  <span>{message.text}</span>
                  {message.seriesId && typeof message.sliceIndex === 'number' && <small>Frame: slice {message.sliceIndex + 1}</small>}
                </p>
              ))}
            </div>
          )}
          <h3>Summary</h3>
          <p>{analysis.summary}</p>
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
          {analysis.referencedAnnotations?.length > 0 && (
            <>
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
            </>
          )}
          <h3>Questions for your clinician</h3>
          <ul>{analysis.questionsForDoctor.map((question) => <li key={question}>{question}</li>)}</ul>
          {analysis.limitations.length > 0 && (
            <>
              <h3>Limitations</h3>
              <ul>{analysis.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
            </>
          )}
        </aside>
      </section>

      <section className="lowerGrid">
        <div className="card">
          <h2>Ankle MRI checklist</h2>
          <div className="checklist">{ankleChecklist.map((item) => <span key={item}>{item}</span>)}</div>
        </div>
        <div className="card">
          <h2>Plain-language glossary</h2>
          <div className="glossary">{patientFriendlyGlossary.map((item) => <p key={item.term}><strong>{item.term}:</strong> {item.explanation}</p>)}</div>
        </div>
      </section>

      {(warnings.length > 0 || error) && (
        <section className="card messages">
          {error && <p className="error">{error}</p>}
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </section>
      )}
    </main>
  );
}
