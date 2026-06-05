# ReadMRI

ReadMRI is a Vercel-ready Next.js prototype for patient-friendly ankle/foot MRI education.

## What it does

- Imports multiple `.dcm` files in the browser and groups them by DICOM series UID.
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

Create `.env.local` or set these in Vercel:

```bash
OPENAI_API_KEY=sk-...
AI_MODEL=gpt-4.1
```

If `OPENAI_API_KEY` is missing, the app returns safe placeholder guidance instead of pretending to interpret images.

## DICOM support notes

This prototype focuses on functionality and supports common uncompressed, single-channel grayscale MR DICOM files. Compressed transfer syntaxes from some scanners/PACS exports may need a server-side DICOM pipeline or a full web imaging stack such as Cornerstone plus codecs.
