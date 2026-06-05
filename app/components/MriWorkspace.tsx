'use client';

import type { ChangeEvent, DragEvent, MouseEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ankleChecklist, patientFriendlyGlossary } from '../lib/ankleKnowledge';
import { expandUploadFiles } from '../lib/archives';
import { clearPersistedWorkspace, loadPersistedWorkspace, savePersistedWorkspace } from '../lib/browserStorage';
import { parseDicomFiles } from '../lib/dicom';
import { parseImageFiles } from '../lib/image';
import { parseVideoFiles, type VideoFrameOptions } from '../lib/video';
import { describeFiles, getDicomCandidateFiles, getFilesFromDataTransfer, isImageFile, isVideoFile, type UploadFile } from '../lib/upload';
import type { AiAnalysis, AiImageReference, Annotation, DicomSeries, DicomSlice } from '../lib/types';

const annotationColors = ['#38bdf8', '#f97316', '#a3e635', '#f472b6', '#facc15'];
const AI_COLOR = '#facc15';
const MAX_CLIENT_IMAGES = 24;

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

function evenlySampleSeries(seriesItems: DicomSeries[], maxImages: number) {
  const selected = seriesItems.filter((item) => item.slices.length > 0);
  if (selected.length === 0) return [];

  const perSeries = Math.max(1, Math.floor(maxImages / selected.length));
  const sampled = selected.flatMap((item) => {
    if (item.slices.length <= perSeries) {
      return item.slices.map((slice, sliceIndex) => ({ series: item, slice, sliceIndex }));
    }

    const lastIndex = item.slices.length - 1;
    const indexes = new Set<number>();
    for (let i = 0; i < perSeries; i += 1) indexes.add(Math.round((i * lastIndex) / Math.max(perSeries - 1, 1)));
    return Array.from(indexes).map((sliceIndex) => ({ series: item, slice: item.slices[sliceIndex], sliceIndex }));
  });

  return sampled.slice(0, maxImages);
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
  const [userQuestion, setUserQuestion] = useState('What do you notice in the selected series, and which exact slices should I ask my clinician about?');
  const [isParsing, setIsParsing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageMessage, setStorageMessage] = useState('');
  const [error, setError] = useState<string>('');
  const [uploadSummary, setUploadSummary] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const activeSeries = useMemo(
    () => series.find((item) => item.id === activeSeriesId) ?? series[0],
    [activeSeriesId, series],
  );
  const activeSlice = activeSeries?.slices[Math.min(sliceIndex, Math.max(activeSeries.slices.length - 1, 0))];
  const selectedSeries = useMemo(
    () => series.filter((item) => selectedSeriesIds.includes(item.id)),
    [selectedSeriesIds, series],
  );
  const visibleAnnotations = annotations.filter(
    (annotation) => annotation.seriesId === activeSeries?.id && annotation.sliceIndex === sliceIndex,
  );
  const sampledImages = useMemo(() => evenlySampleSeries(selectedSeries, MAX_CLIENT_IMAGES), [selectedSeries]);

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
        setUserQuestion(persisted.userQuestion || 'What do you notice in the selected series, and which exact slices should I ask my clinician about?');
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
      savePersistedWorkspace({
        series,
        annotations,
        analysis,
        activeSeriesId: activeSeries?.id ?? activeSeriesId,
        sliceIndex,
        selectedSeriesIds,
        uploadSummary,
        userQuestion,
        savedAt: new Date().toISOString(),
      }).catch((storageError) => setWarnings((existing) => [...existing, storageError instanceof Error ? storageError.message : 'Unable to save this study in local browser storage.']));
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [activeSeries?.id, activeSeriesId, analysis, annotations, isHydrated, selectedSeriesIds, series, sliceIndex, uploadSummary, userQuestion]);

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

  const addAnnotation = (event: MouseEvent<HTMLDivElement>) => {
    if (!activeSlice || !activeSeries || !imageRef.current) return;
    const bounds = imageRef.current.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return;
    setAnnotations((existing) => [
      ...existing,
      {
        id: crypto.randomUUID(),
        x,
        y,
        label: annotationDraft.label || 'Annotation',
        note: annotationDraft.note,
        color: annotationColors[existing.length % annotationColors.length],
        sliceIndex,
        seriesId: activeSeries.id,
        source: 'user',
      },
    ]);
  };

  const jumpToReference = (reference: Pick<AiImageReference, 'seriesId' | 'sliceIndex'>) => {
    setActiveSeriesId(reference.seriesId);
    setSliceIndex(reference.sliceIndex);
  };

  const toggleSelectedSeries = (seriesId: string) => {
    setSelectedSeriesIds((existing) => existing.includes(seriesId) ? existing.filter((id) => id !== seriesId) : [...existing, seriesId]);
  };

  const resetWorkspace = async () => {
    await clearPersistedWorkspace();
    setSeries([]);
    setActiveSeriesId('');
    setSliceIndex(0);
    setSelectedSeriesIds([]);
    setAnnotations([]);
    setAnalysis(createDefaultAnalysis());
    setUploadSummary('');
    setStorageMessage('Cleared locally saved browser study data.');
  };

  const findSlice = (seriesId: string, targetSliceIndex: number): DicomSlice | undefined => series
    .find((item) => item.id === seriesId)
    ?.slices[targetSliceIndex];

  const runAnalysis = async () => {
    if (!selectedSeries.length || !sampledImages.length) return;
    setIsAnalyzing(true);
    setError('');
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userQuestion,
          series: selectedSeries.map((item) => ({
            id: item.id,
            description: item.description,
            sequenceName: item.sequenceName,
            plane: item.plane,
            sliceCount: item.slices.length,
            metadata: {
              bodyPartExamined: item.slices[0]?.bodyPartExamined,
              studyDescription: item.slices[0]?.studyDescription,
              pixelSpacing: item.slices[0]?.pixelSpacing,
              windowCenter: item.slices[0]?.windowCenter,
              windowWidth: item.slices[0]?.windowWidth,
            },
          })),
          annotations: annotations.filter((annotation) => selectedSeriesIds.includes(annotation.seriesId)),
          images: sampledImages.map(({ series: item, slice, sliceIndex: imageSliceIndex }, imageIndex) => ({
            imageId: `image-${imageIndex + 1}`,
            seriesId: item.id,
            seriesDescription: item.description,
            sliceIndex: imageSliceIndex,
            fileName: slice.fileName,
            instanceNumber: slice.instanceNumber,
            dataUrl: slice.canvasDataUrl,
          })),
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'AI analysis failed.');
      const nextAnalysis = json.analysis as AiAnalysis;
      setAnalysis(nextAnalysis);
      setAnnotations((existing) => [
        ...existing.filter((annotation) => annotation.source !== 'ai'),
        ...(nextAnalysis.referencedAnnotations ?? []).map((annotation, index) => ({
          ...annotation,
          id: annotation.id || `ai-${Date.now()}-${index}`,
          color: annotation.color || AI_COLOR,
          source: 'ai' as const,
        })),
      ]);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'AI analysis failed.');
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
            Import several DICOM/image/video series, restore them from browser storage after refresh, view one series at a time, and ask AI focused questions about whichever series you select.
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

          <div className="seriesPicker">
            <div className="seriesPickerHeader">
              <label>Series AI should inspect</label>
              <button type="button" onClick={() => setSelectedSeriesIds(series.map((item) => item.id))} disabled={!series.length}>All</button>
              <button type="button" onClick={() => setSelectedSeriesIds([])} disabled={!series.length}>None</button>
            </div>
            {series.length ? series.map((item) => (
              <label className="seriesCheck" key={item.id}>
                <input type="checkbox" checked={selectedSeriesIds.includes(item.id)} onChange={() => toggleSelectedSeries(item.id)} />
                <span>{item.description} <small>{item.plane} · {item.slices.length} slices</small></span>
              </label>
            )) : <p className="muted">Upload series before selecting images for AI.</p>}
          </div>

          <div className="field">
            <label>Ask AI a specific question</label>
            <textarea value={userQuestion} onChange={(event) => setUserQuestion(event.target.value)} placeholder="Example: Compare the sagittal and axial series for Achilles tendon concerns and point me to exact slices." />
          </div>

          <div className="field">
            <label>Manual annotation label</label>
            <input value={annotationDraft.label} onChange={(event) => setAnnotationDraft({ ...annotationDraft, label: event.target.value })} />
          </div>
          <div className="field">
            <label>Manual question/note</label>
            <textarea value={annotationDraft.note} onChange={(event) => setAnnotationDraft({ ...annotationDraft, note: event.target.value })} placeholder="Example: Is this tendon swollen?" />
          </div>
          <button className="primary" onClick={runAnalysis} disabled={!sampledImages.length || isAnalyzing}>
            {isAnalyzing ? `Analyzing ${sampledImages.length} image references…` : `Ask AI about ${selectedSeries.length || 0} selected series`}
          </button>
          <p className="hint">Click directly on the MRI image to drop your own annotation. AI answers can also add yellow image-linked callouts.</p>
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
                <img ref={imageRef} src={activeSlice.canvasDataUrl} alt="Rendered DICOM MRI slice" draggable={false} />
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
                    title={annotation.note}
                  >
                    <span style={{ background: annotation.color }}>{annotation.label}</span>
                  </div>
                ))}
              </div>
              {visibleAnnotations.length > 0 && (
                <div className="annotationList">
                  {visibleAnnotations.map((annotation) => (
                    <button key={annotation.id} type="button" onClick={() => jumpToReference({ seriesId: annotation.seriesId, sliceIndex: annotation.sliceIndex })}>
                      <strong>{annotation.source === 'ai' ? 'AI' : 'You'}: {annotation.label}</strong>
                      <small>{annotation.note || 'No note'}</small>
                    </button>
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
            <h2>Image-linked interpretation support</h2>
          </div>
          <p className="notice">{analysis.safetyNotice}</p>
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
          )) : <p className="muted">No AI findings yet. Select one or more series, ask a question, and run the explanation.</p>}
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
