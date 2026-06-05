'use client';

import type { ChangeEvent, DragEvent, MouseEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { ankleChecklist, patientFriendlyGlossary } from '../lib/ankleKnowledge';
import { parseDicomFiles } from '../lib/dicom';
import { describeFiles, getFilesFromDataTransfer, type UploadFile } from '../lib/upload';
import type { AiAnalysis, Annotation, DicomSeries } from '../lib/types';

const annotationColors = ['#38bdf8', '#f97316', '#a3e635', '#f472b6', '#facc15'];

function createDefaultAnalysis(): AiAnalysis {
  return {
    summary: 'Upload ankle/foot MRI DICOM series, pick representative slices, and run AI explanation for patient-friendly education.',
    safetyNotice: 'This app is educational and cannot diagnose. Always rely on your radiology report and a licensed clinician.',
    structuresChecklist: ankleChecklist,
    findings: [],
    questionsForDoctor: [
      'Which finding best explains my symptoms?',
      'Is this acute injury, overuse, arthritis, or an incidental finding?',
      'What activities should I avoid while waiting for follow-up?',
    ],
    limitations: ['No MRI has been analyzed yet.'],
  };
}

export default function MriWorkspace() {
  const [series, setSeries] = useState<DicomSeries[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState<string>('');
  const [sliceIndex, setSliceIndex] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState({ label: 'Area to ask about', note: '' });
  const [analysis, setAnalysis] = useState<AiAnalysis>(createDefaultAnalysis);
  const [isParsing, setIsParsing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string>('');
  const [uploadSummary, setUploadSummary] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const activeSeries = useMemo(
    () => series.find((item) => item.id === activeSeriesId) ?? series[0],
    [activeSeriesId, series],
  );
  const activeSlice = activeSeries?.slices[Math.min(sliceIndex, Math.max(activeSeries.slices.length - 1, 0))];
  const visibleAnnotations = annotations.filter(
    (annotation) => annotation.seriesId === activeSeries?.id && annotation.sliceIndex === sliceIndex,
  );

  const loadFiles = async (incomingFiles: UploadFile[]) => {
    const { dicomCandidates, summary } = describeFiles(incomingFiles);
    setUploadSummary(summary);
    if (!dicomCandidates.length) {
      setError('No files were selected. Choose individual DICOM files or a folder that contains the MRI slices.');
      return;
    }

    setIsParsing(true);
    setError('');
    setWarnings([]);
    try {
      const result = await parseDicomFiles(dicomCandidates);
      setSeries(result.series);
      setWarnings(result.warnings);
      setActiveSeriesId(result.series[0]?.id ?? '');
      setSliceIndex(0);
      setAnnotations([]);
      if (!result.series.length) {
        setError('No readable MRI slices were found. Select the folder that contains the actual DICOM image files (often extensionless files inside series folders), not just a DICOMDIR/index file. Compressed DICOM transfer syntaxes are not supported in this browser viewer.');
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
      },
    ]);
  };

  const runAnalysis = async () => {
    if (!activeSlice || !activeSeries) return;
    setIsAnalyzing(true);
    setError('');
    try {
      const representativeSlices = activeSeries.slices.filter((_, index) => {
        if (activeSeries.slices.length <= 5) return true;
        const step = Math.max(1, Math.floor(activeSeries.slices.length / 5));
        return index % step === 0;
      }).slice(0, 6);

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series: {
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
          annotations: annotations.filter((annotation) => annotation.seriesId === activeSeries.id),
          images: representativeSlices.map((slice) => ({
            fileName: slice.fileName,
            instanceNumber: slice.instanceNumber,
            dataUrl: slice.canvasDataUrl,
          })),
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'AI analysis failed.');
      setAnalysis(json.analysis);
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
          <h1>ReadMRI helps non-experts explore DICOM ankle MRI series.</h1>
          <p className="lede">
            Import DCM files, review slices by series, add visible questions/annotations, and generate a structured AI explanation that stays clear about uncertainty and doctor follow-up.
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
            <span>{isParsing ? 'Reading DICOM…' : 'Upload DICOM files or folders'}</span>
            <small>Click to pick files, or drag a study/series folder here. Extensionless DICOM files are accepted.</small>
            <input type="file" multiple onChange={handleFiles} />
          </label>
          <label className="folderUpload">
            Select a DICOM folder
            <input
              type="file"
              multiple
              onChange={handleFiles}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
          </label>
          {uploadSummary && <p className="hint uploadSummary">{uploadSummary}</p>}

          <div className="field">
            <label>Series</label>
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

          <div className="field">
            <label>Annotation label</label>
            <input value={annotationDraft.label} onChange={(event) => setAnnotationDraft({ ...annotationDraft, label: event.target.value })} />
          </div>
          <div className="field">
            <label>Question/note</label>
            <textarea value={annotationDraft.note} onChange={(event) => setAnnotationDraft({ ...annotationDraft, note: event.target.value })} placeholder="Example: Is this tendon swollen?" />
          </div>
          <button className="primary" onClick={runAnalysis} disabled={!activeSlice || isAnalyzing}>
            {isAnalyzing ? 'Analyzing representative slices…' : 'Run AI explanation'}
          </button>
          <p className="hint">Click directly on the MRI image to drop the current annotation.</p>
        </aside>

        <section className="card viewer">
          {activeSlice ? (
            <>
              <div className="viewerHeader">
                <div>
                  <h2>{activeSeries?.description}</h2>
                  <p>{activeSeries?.plane} · {activeSeries?.sequenceName || 'sequence not labeled'} · {activeSlice.rows}×{activeSlice.columns}</p>
                </div>
                <span className="badge">{activeSlice.fileName}</span>
              </div>
              <div className="imageStage" onClick={addAnnotation} role="button" tabIndex={0} aria-label="MRI slice annotation canvas">
                <img ref={imageRef} src={activeSlice.canvasDataUrl} alt="Rendered DICOM MRI slice" draggable={false} />
                {visibleAnnotations.map((annotation) => (
                  <div key={annotation.id} className="pin" style={{ left: `${annotation.x}%`, top: `${annotation.y}%`, borderColor: annotation.color }}>
                    <span style={{ background: annotation.color }}>{annotation.label}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">Upload individual DICOM files, drag a series folder, or select all extensionless DICOM image files from your MRI export.</div>
          )}
        </section>

        <aside className="card analysis">
          <div className="sectionTitle">
            <p className="eyebrow">AI explanation</p>
            <h2>Patient-friendly interpretation support</h2>
          </div>
          <p className="notice">{analysis.safetyNotice}</p>
          <h3>Summary</h3>
          <p>{analysis.summary}</p>
          <h3>Possible findings / discussion points</h3>
          {analysis.findings.length ? analysis.findings.map((finding) => (
            <article className="finding" key={`${finding.region}-${finding.plainLanguage}`}>
              <strong>{finding.region} <span>{finding.confidence}</span></strong>
              <p>{finding.plainLanguage}</p>
              <small>{finding.whyItMatters} Follow-up: {finding.suggestedFollowUp}</small>
            </article>
          )) : <p className="muted">No AI findings yet. Add DICOM slices and run the explanation.</p>}
          <h3>Questions for your clinician</h3>
          <ul>{analysis.questionsForDoctor.map((question) => <li key={question}>{question}</li>)}</ul>
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
