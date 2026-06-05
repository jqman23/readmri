# ReadMRI

ReadMRI is a Vercel-ready Next.js prototype for patient-friendly ankle/foot MRI education.

## What it does

- Imports individual `.dcm`/extensionless DICOM files, whole study folders or mounted CD exports, and common archive formats (`.zip`, `.tar`, `.tgz`, `.gz`) in the browser before grouping slices by DICOM series UID.
- Renders uncompressed grayscale MR slices to a canvas-backed PNG for review.
- Lets users move through slices, switch series, and drop annotations/questions on the MRI image.
- Sends representative rendered slices, metadata, and annotations to a server API for an AI explanation.
- Keeps the AI response educational: it must state limitations, avoid diagnosis, and generate questions for a clinician.

## AI choice

The app defaults to OpenAI `gpt-4.1` because it has strong API vision support, structured output reliability, and is easy to deploy on Vercel using a single serverless route. The model is configurable with `AI_MODEL` so you can test future medical-imaging-capable models without changing the UI.

Important: current general-purpose multimodal models are not approved replacements for radiologists and should not be used as autonomous diagnostic systems.

## Local development

```bash
npm install
npm run dev
```

## Environment variables

Never hardcode or commit a real OpenAI API key, even if the GitHub repository is private. Keep the key in local environment variables or your deployment provider secret settings so it can be rotated without code changes.

For local development, copy the example file and add your real key only to `.env.local`:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```bash
OPENAI_API_KEY=sk-your-real-key
AI_MODEL=gpt-4.1
```

For Vercel, set `OPENAI_API_KEY` and optional `AI_MODEL` in Project Settings → Environment Variables.

If `OPENAI_API_KEY` is missing, the app returns safe placeholder guidance instead of pretending to interpret images.

## DICOM support notes

This prototype focuses on functionality and supports common uncompressed, single-channel grayscale MR DICOM slices. The uploader can unpack common compressed export archives (`.zip`, `.tar`, `.tgz`, `.gz`) directly in the browser, so zipped CD/study exports can be dropped in without manually extracting them first. DICOM image slices that use compressed pixel transfer syntaxes from some scanners/PACS exports may still need a server-side DICOM pipeline or a full web imaging stack such as Cornerstone plus codecs.
