# ReadMRI

ReadMRI is a Vercel-ready Next.js prototype for patient-friendly ankle/foot MRI education.

## What it does

- Imports individual `.dcm`/extensionless DICOM files, whole study folders or mounted CD exports, and common archive formats (`.zip`, `.tar`, `.tgz`, `.gz`) in the browser before grouping slices by DICOM series UID.
- Renders uncompressed grayscale MR slices, RLE-compressed slices, and browser-decodable encapsulated JPEG/JPEG 2000 DICOM frames to canvas-backed PNGs for review.
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

This prototype accepts DICOM slices from loose files, folders/CD exports, and common compressed export archives (`.zip`, `.tar`, `.tgz`, `.gz`) directly in the browser. It renders uncompressed grayscale slices, deflated Explicit VR datasets, DICOM RLE Lossless slices, and encapsulated JPEG/JPEG 2000 slices when the current browser has a native decoder for that image stream. If a DICOM uses a pixel transfer syntax the browser cannot decode (for example some JPEG Lossless, JPEG-LS, or JPEG 2000 combinations), ReadMRI still loads the slice metadata and shows a clear placeholder/warning instead of rejecting the DCM file outright.


Tip for exports like Ambra/Visage-style download dialogs: if the advanced menu offers **Preferred Transfer Syntax**, choose **Explicit VR Little Endian** for the most reliable browser import. If you download a DICOM CD ZIP, keep the whole ZIP/folder together; `DICOMDIR`, reports, and presentation-state files are expected and will be skipped while image slices are imported.
