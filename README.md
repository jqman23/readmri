# ReadMRI

ReadMRI is a Vercel-ready Next.js prototype for patient-friendly ankle/foot MRI education.

## What it does

- Imports individual `.dcm`/extensionless DICOM files, JPEG/PNG image exports, MP4/video exports, whole study folders or mounted CD exports, and common archive formats (`.zip`, `.tar`, `.tgz`, `.gz`) in the browser before grouping slices by DICOM series UID, image-export order, or video-derived frame sequence.
- Renders uncompressed grayscale MR slices, browser-decoded JPEG/PNG exports, and browser-decoded video frames to canvas-backed PNGs for review.
- Lets users move through slices, switch series, and drop annotations/questions on the MRI image.
- Sends representative rendered slices, metadata, and annotations to a server API for an AI explanation.
- Adds a study-scout workflow that first ranks series by names/planes/sequences, samples up to 20 candidate slices, reviews them in Groq-friendly batches of 5 images, and returns jump links to promising slices.
- Keeps the AI response exploratory and useful for report-backed learning while still avoiding autonomous diagnosis.

## AI choice

The app can use either Groq or OpenAI through server-side environment variables. Groq is a good low-cost/free-limit option when an OpenAI key returns quota errors; set `AI_PROVIDER=groq`, `GROQ_API_KEY`, and optionally `GROQ_MODEL`. OpenAI remains supported with `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL`.

The default Groq vision model is `meta-llama/llama-4-scout-17b-16e-instruct`; the default OpenAI model is `gpt-4.1`. You can also use the backward-compatible `AI_MODEL` variable if a provider-specific model is not set.

Important: current general-purpose multimodal models are not approved replacements for radiologists and should not be used as autonomous diagnostic systems. ReadMRI's scout mode is meant to help patients who already have a report or clinician guidance navigate toward relevant images for discussion.

## Local development

```bash
npm install
npm run dev
```

## Environment variables

Never hardcode or commit a real OpenAI or Groq API key, even if the GitHub repository is private. Keep the key in local environment variables or your deployment provider secret settings so it can be rotated without code changes.

For local development, copy the example file and add your real key only to `.env.local`:

```bash
cp .env.example .env.local
```

Then edit `.env.local`. For Groq, use:

```bash
AI_PROVIDER=groq
GROQ_API_KEY=gsk-your-real-groq-key
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
```

For OpenAI, use:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-real-openai-key
OPENAI_MODEL=gpt-4.1
```

If `AI_PROVIDER` is omitted, the server uses Groq when only `GROQ_API_KEY` is present; otherwise it uses OpenAI. For Vercel, add the same variables in Project Settings → Environment Variables.

If the selected provider key is missing, the app returns safe placeholder guidance instead of pretending to interpret images.

## DICOM support notes

This prototype focuses on functionality and supports common uncompressed, single-channel grayscale MR DICOM slices. The uploader can also import JPEG/PNG/BMP/GIF/WebP image exports from a ZIP or folder when a portal download gives image files instead of readable DICOM slices. It can also import MP4/M4V/MOV/WebM video exports; when video files are selected, the browser prompts for the number of frames/slices to extract and the FPS step to use (for example, 50 frames at 20 FPS). The uploader can unpack common compressed export archives (`.zip`, `.tar`, `.tgz`, `.gz`) directly in the browser, so zipped CD/study exports can be dropped in without manually extracting them first. DICOM image slices that use compressed pixel transfer syntaxes from some scanners/PACS exports may still need a server-side DICOM pipeline or a full web imaging stack such as Cornerstone plus codecs.
