import type { DicomSeries, DicomSlice } from './types';

export type VideoFrameOptions = {
  frameCount: number;
  fps: number;
};

const MAX_VIDEO_FRAMES = 300;

function waitForEvent<T extends Event>(target: EventTarget, eventName: string, rejectEventName?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      if (rejectEventName) target.removeEventListener(rejectEventName, onError);
    };
    const onSuccess = (event: Event) => {
      cleanup();
      resolve(event as T);
    };
    const onError = () => {
      cleanup();
      reject(new Error('The browser could not decode this video file.'));
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    if (rejectEventName) target.addEventListener(rejectEventName, onError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, seconds: number) {
  if (Math.abs(video.currentTime - seconds) < 0.001 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = waitForEvent(video, 'seeked', 'error');
  video.currentTime = seconds;
  await seeked;
}

function makeVideoSeriesId(fileName: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `video-${fileName}-${random}`;
}

function captureFrame(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, video: HTMLVideoElement) {
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export async function parseVideoFiles(files: File[], options: VideoFrameOptions): Promise<{ series: DicomSeries[]; warnings: string[] }> {
  const series: DicomSeries[] = [];
  const warnings: string[] = [];
  const frameCount = Math.min(Math.max(1, Math.floor(options.frameCount)), MAX_VIDEO_FRAMES);
  const fps = Math.max(0.1, options.fps);

  if (options.frameCount > MAX_VIDEO_FRAMES) {
    warnings.push(`Video import capped at ${MAX_VIDEO_FRAMES} frames to keep the browser responsive.`);
  }

  for (const file of files) {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    try {
      video.src = objectUrl;
      await waitForEvent(video, 'loadedmetadata', 'error');
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForEvent(video, 'loadeddata', 'error');
      }
      if (!video.videoWidth || !video.videoHeight) throw new Error('Video metadata did not include width/height.');

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is not available.');

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : frameCount / fps;
      const requestedDuration = frameCount / fps;
      const useEvenSpacing = requestedDuration > duration + (1 / fps);
      if (useEvenSpacing) {
        warnings.push(`${file.name}: requested ${frameCount} frames at ${fps} fps is longer than the video duration, so frames were sampled evenly across ${duration.toFixed(2)} seconds.`);
      }

      const seriesId = makeVideoSeriesId(file.name);
      const slices: DicomSlice[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const requestedTime = useEvenSpacing
          ? (duration * index) / Math.max(frameCount - 1, 1)
          : index / fps;
        const time = Math.min(Math.max(requestedTime, 0), Math.max(duration - 0.001, 0));
        await seekVideo(video, time);

        slices.push({
          id: `${seriesId}-frame-${index + 1}`,
          fileName: `${file.name} · frame ${index + 1}`,
          rows: video.videoHeight,
          columns: video.videoWidth,
          instanceNumber: index + 1,
          seriesInstanceUID: seriesId,
          seriesDescription: `${file.name} video frames`,
          sequenceName: `${fps} fps video import`,
          sliceLocation: index,
          pixelSpacing: '',
          windowCenter: Number.NaN,
          windowWidth: Number.NaN,
          modality: 'VIDEO',
          studyDescription: 'Video-derived image sequence',
          bodyPartExamined: '',
          acquisitionPlane: 'unknown',
          canvasDataUrl: captureFrame(canvas, context, video),
        });
      }

      series.push({
        id: seriesId,
        description: `${file.name} video frames`,
        sequenceName: `${frameCount} frames @ ${fps} fps`,
        plane: 'unknown',
        slices,
      });
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not import video.'}`);
    } finally {
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
    }
  }

  return { series, warnings };
}
