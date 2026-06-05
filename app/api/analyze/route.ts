import OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { aiSystemPrompt, ankleChecklist } from '../../lib/ankleKnowledge';
import type { AiAnalysis, AiFinding, Annotation } from '../../lib/types';

export const runtime = 'nodejs';

const referenceSchema = z.object({
  seriesId: z.string(),
  seriesDescription: z.string(),
  sliceIndex: z.number(),
  fileName: z.string(),
  instanceNumber: z.number(),
  label: z.string(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  width: z.number().min(0).max(100).optional(),
  height: z.number().min(0).max(100).optional(),
});

const annotationSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  note: z.string(),
  sliceIndex: z.number(),
  seriesId: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  color: z.string().optional(),
  source: z.enum(['user', 'ai']).optional(),
});

const analyzeSchema = z.object({
  question: z.string().default('Give a patient-friendly explanation of the selected MRI series.'),
  series: z.array(z.object({
    id: z.string(),
    description: z.string(),
    sequenceName: z.string().optional(),
    plane: z.string(),
    sliceCount: z.number(),
    metadata: z.record(z.unknown()).optional(),
  })).min(1),
  annotations: z.array(annotationSchema).default([]),
  images: z.array(z.object({
    imageId: z.string(),
    seriesId: z.string(),
    seriesDescription: z.string(),
    sliceIndex: z.number(),
    fileName: z.string(),
    instanceNumber: z.number(),
    dataUrl: z.string().startsWith('data:image/png;base64,'),
  })).min(1).max(24),
});

type AiProvider = 'openai' | 'groq';

type ProviderConfig = {
  provider: AiProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
  maxImages: number;
};

const aiFindingSchema = z.object({
  region: z.string().default('Unspecified region'),
  plainLanguage: z.string().default('No plain-language explanation was provided.'),
  whyItMatters: z.string().default('Discuss this with a clinician.'),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
  suggestedFollowUp: z.string().default('Ask your clinician to correlate this with symptoms and the official radiology report.'),
  references: z.array(referenceSchema).default([]),
});

const aiAnalysisSchema = z.object({
  summary: z.string().default('The model did not provide a summary.'),
  safetyNotice: z.string().default('Educational support only; consult your clinician.'),
  structuresChecklist: z.array(z.string()).default(ankleChecklist),
  findings: z.array(aiFindingSchema).default([]),
  questionsForDoctor: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  referencedAnnotations: z.array(annotationSchema).default([]),
});

function providerConfig(): ProviderConfig {
  const configuredProvider = process.env.AI_PROVIDER?.toLowerCase();
  const provider: AiProvider = configuredProvider === 'groq' || (!configuredProvider && process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY)
    ? 'groq'
    : 'openai';

  if (provider === 'groq') {
    return {
      provider,
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? process.env.AI_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
      baseURL: 'https://api.groq.com/openai/v1',
      maxImages: 5,
    };
  }

  return {
    provider,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? process.env.AI_MODEL ?? 'gpt-4.1',
    maxImages: 16,
  };
}

function fallbackAnalysis(reason: string): AiAnalysis {
  return {
    summary: 'AI image review is not configured yet, but the viewer can still organize multiple series, restore them from local browser storage, show exact slices, and capture annotations/questions for your clinician.',
    safetyNotice: 'Educational support only. This is not a diagnosis and should not replace a radiology report or medical care.',
    structuresChecklist: ankleChecklist,
    findings: [
      {
        region: 'Configuration',
        plainLanguage: reason,
        whyItMatters: 'A medical-image explanation should be generated only when a trusted model is configured and the user understands the limits.',
        confidence: 'low',
        suggestedFollowUp: 'Set AI_PROVIDER=groq with GROQ_API_KEY, or set AI_PROVIDER=openai with OPENAI_API_KEY, then rerun analysis.',
        references: [],
      },
    ],
    questionsForDoctor: [
      'Can you walk me through the radiology report in plain language?',
      'Which structures on the MRI correspond to my pain location?',
      'Do I need immobilization, physical therapy, injections, or surgical evaluation?',
    ],
    limitations: ['No configured AI model reviewed these images.'],
    referencedAnnotations: [],
  };
}

function extractJson(text: string): AiAnalysis {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const raw = fenced ?? (objectStart >= 0 && objectEnd > objectStart ? text.slice(objectStart, objectEnd + 1) : '{}');
  const parsed = JSON.parse(raw);
  const result = aiAnalysisSchema.parse(parsed);
  return {
    ...result,
    findings: result.findings as AiFinding[],
    referencedAnnotations: result.referencedAnnotations as Annotation[],
  };
}

export async function POST(request: NextRequest) {
  const body = analyzeSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const config = providerConfig();
  if (!config.apiKey) {
    const keyName = config.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    return NextResponse.json({ analysis: fallbackAnalysis(`${keyName} is missing for AI_PROVIDER=${config.provider}, so the app returned safe placeholder guidance instead of image interpretation.`) });
  }

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const payload = body.data;
  const images = payload.images.slice(0, config.maxImages);
  const validImageReferences = images.map(({ dataUrl, ...image }) => image);

  const responseContract = {
    summary: 'string',
    safetyNotice: 'string emphasizing educational/non-diagnostic limits',
    structuresChecklist: ankleChecklist,
    findings: [
      {
        region: 'specific anatomy or image pattern',
        plainLanguage: 'answer the user question in patient-friendly terms',
        whyItMatters: 'why this may matter clinically without diagnosing',
        confidence: 'low | medium | high',
        suggestedFollowUp: 'clinician/radiology follow-up question',
        references: [{ seriesId: 'must match provided image', seriesDescription: 'provided seriesDescription', sliceIndex: 0, fileName: 'provided fileName', instanceNumber: 1, label: 'short clickable label', x: 50, y: 50, width: 15, height: 15 }],
      },
    ],
    questionsForDoctor: ['string'],
    limitations: ['string'],
    referencedAnnotations: [{ id: 'ai-generated id', seriesId: 'must match provided image', sliceIndex: 0, x: 50, y: 50, width: 15, height: 15, label: 'short callout', note: 'what the AI is referencing', color: '#facc15', source: 'ai' }],
  };

  const userText = [
    'Explain the selected ankle/foot MRI series for an educated patient without making a diagnosis.',
    `User question: ${payload.question}`,
    `Selected series metadata: ${JSON.stringify(payload.series)}`,
    `Images attached for review, in order: ${JSON.stringify(validImageReferences)}`,
    `User annotations/questions already on images: ${JSON.stringify(payload.annotations)}`,
    `Return ONLY JSON matching this contract: ${JSON.stringify(responseContract)}`,
    'Every finding that talks about a visible image detail must include one or more references using only the provided seriesId and sliceIndex values.',
    'When useful, add referencedAnnotations with percentage x/y coordinates and optional width/height so the UI can draw yellow callouts on exact slices.',
    'Be conservative. Say when the attached representative images are insufficient and when full DICOM/radiologist review is needed.',
  ].join('\n');

  try {
    if (config.provider === 'groq') {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: aiSystemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              ...images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: image.dataUrl },
              })),
            ],
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 2400,
        response_format: { type: 'json_object' },
      });

      return NextResponse.json({ analysis: extractJson(response.choices[0]?.message.content ?? '{}') });
    }

    const response = await client.responses.create({
      model: config.model,
      input: [
        { role: 'system', content: aiSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            ...images.map((image) => ({
              type: 'input_image' as const,
              image_url: image.dataUrl,
              detail: 'high' as const,
            })),
          ],
        },
      ],
      temperature: 0.2,
      max_output_tokens: 2400,
    });

    return NextResponse.json({ analysis: extractJson(response.output_text) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : `${config.provider} failed to analyze the selected series.` },
      { status: 502 },
    );
  }
}
