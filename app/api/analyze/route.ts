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

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(),
  seriesId: z.string().optional(),
  sliceIndex: z.number().optional(),
});

const currentFrameSchema = z.object({
  imageId: z.string(),
  seriesId: z.string(),
  seriesDescription: z.string(),
  sliceIndex: z.number(),
  fileName: z.string(),
  instanceNumber: z.number(),
  dataUrl: z.string().regex(/^data:image\/(png|jpe?g|webp);base64,/),
});

const analyzeSchema = z.object({
  question: z.string().default('Explain this current MRI frame in plain language.'),
  series: z.object({
    id: z.string(),
    description: z.string(),
    sequenceName: z.string().optional(),
    plane: z.string(),
    sliceCount: z.number(),
    metadata: z.record(z.unknown()).optional(),
  }),
  annotations: z.array(annotationSchema).default([]),
  currentFrame: currentFrameSchema,
  chatHistory: z.array(chatMessageSchema).default([]),
});

type AiProvider = 'openai' | 'groq';

class AiResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseFormatError';
  }
}

type ProviderConfig = {
  provider: AiProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
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
    };
  }

  return {
    provider,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? process.env.AI_MODEL ?? 'gpt-4.1',
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

const aiAnalysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'safetyNotice', 'structuresChecklist', 'findings', 'questionsForDoctor', 'limitations', 'referencedAnnotations'],
  properties: {
    summary: { type: 'string' },
    safetyNotice: { type: 'string' },
    structuresChecklist: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['region', 'plainLanguage', 'whyItMatters', 'confidence', 'suggestedFollowUp', 'references'],
        properties: {
          region: { type: 'string' },
          plainLanguage: { type: 'string' },
          whyItMatters: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          suggestedFollowUp: { type: 'string' },
          references: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['seriesId', 'seriesDescription', 'sliceIndex', 'fileName', 'instanceNumber', 'label'],
              properties: {
                seriesId: { type: 'string' },
                seriesDescription: { type: 'string' },
                sliceIndex: { type: 'number' },
                fileName: { type: 'string' },
                instanceNumber: { type: 'number' },
                label: { type: 'string' },
                x: { type: 'number', minimum: 0, maximum: 100 },
                y: { type: 'number', minimum: 0, maximum: 100 },
                width: { type: 'number', minimum: 0, maximum: 100 },
                height: { type: 'number', minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
    },
    questionsForDoctor: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    referencedAnnotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'note', 'sliceIndex', 'seriesId', 'x', 'y'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          note: { type: 'string' },
          sliceIndex: { type: 'number' },
          seriesId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          color: { type: 'string' },
          source: { type: 'string', enum: ['user', 'ai'] },
        },
      },
    },
  },
} as const;

function extractFirstJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith('{')) return fenced;

  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeProviderAnalysis(value: unknown, frame: z.infer<typeof currentFrameSchema>): unknown {
  const objectValue = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    summary: stringOrDefault(objectValue.summary, 'I reviewed the current frame, but the provider response was incomplete.'),
    safetyNotice: stringOrDefault(objectValue.safetyNotice, 'Educational support only. This is not a diagnosis and should not replace a radiology report or medical care.'),
    structuresChecklist: arrayOrEmpty(objectValue.structuresChecklist).filter((item): item is string => typeof item === 'string').length
      ? arrayOrEmpty(objectValue.structuresChecklist).filter((item): item is string => typeof item === 'string')
      : ankleChecklist,
    findings: arrayOrEmpty(objectValue.findings).map((finding, index) => {
      const findingObject = finding && typeof finding === 'object' ? finding as Record<string, unknown> : {};
      return {
        region: stringOrDefault(findingObject.region, `Current frame observation ${index + 1}`),
        plainLanguage: stringOrDefault(findingObject.plainLanguage, 'The model mentioned this area but did not provide a plain-language explanation.'),
        whyItMatters: stringOrDefault(findingObject.whyItMatters, 'Ask your clinician how this single-frame observation fits the full MRI study and your symptoms.'),
        confidence: ['low', 'medium', 'high'].includes(String(findingObject.confidence)) ? findingObject.confidence : 'low',
        suggestedFollowUp: stringOrDefault(findingObject.suggestedFollowUp, 'Ask your clinician or radiologist to correlate this with the full DICOM series.'),
        references: (arrayOrEmpty(findingObject.references).length ? arrayOrEmpty(findingObject.references) : [{}]).map((reference, referenceIndex) => {
          const referenceObject = reference && typeof reference === 'object' ? reference as Record<string, unknown> : {};
          return {
            seriesId: frame.seriesId,
            seriesDescription: frame.seriesDescription,
            sliceIndex: frame.sliceIndex,
            fileName: frame.fileName,
            instanceNumber: frame.instanceNumber,
            label: stringOrDefault(referenceObject.label, referenceIndex === 0 ? 'Current frame' : `Current frame ${referenceIndex + 1}`),
            x: typeof referenceObject.x === 'number' ? referenceObject.x : undefined,
            y: typeof referenceObject.y === 'number' ? referenceObject.y : undefined,
            width: typeof referenceObject.width === 'number' ? referenceObject.width : undefined,
            height: typeof referenceObject.height === 'number' ? referenceObject.height : undefined,
          };
        }),
      };
    }),
    questionsForDoctor: arrayOrEmpty(objectValue.questionsForDoctor).filter((item): item is string => typeof item === 'string'),
    limitations: arrayOrEmpty(objectValue.limitations).filter((item): item is string => typeof item === 'string'),
    referencedAnnotations: arrayOrEmpty(objectValue.referencedAnnotations).map((annotation, index) => {
      const annotationObject = annotation && typeof annotation === 'object' ? annotation as Record<string, unknown> : {};
      return {
        id: typeof annotationObject.id === 'string' ? annotationObject.id : `ai-current-frame-${index + 1}`,
        label: stringOrDefault(annotationObject.label, `AI callout ${index + 1}`),
        note: stringOrDefault(annotationObject.note, 'AI-generated callout on the current frame.'),
        sliceIndex: frame.sliceIndex,
        seriesId: frame.seriesId,
        x: typeof annotationObject.x === 'number' ? annotationObject.x : 50,
        y: typeof annotationObject.y === 'number' ? annotationObject.y : 50,
        width: typeof annotationObject.width === 'number' ? annotationObject.width : 12,
        height: typeof annotationObject.height === 'number' ? annotationObject.height : 12,
        color: typeof annotationObject.color === 'string' ? annotationObject.color : '#facc15',
        source: 'ai',
      };
    }),
  };
}

function parseAiAnalysis(value: unknown, frame: z.infer<typeof currentFrameSchema>): AiAnalysis {
  const result = aiAnalysisSchema.parse(normalizeProviderAnalysis(value, frame));
  return {
    ...result,
    findings: (result.findings as AiFinding[]).map((finding) => ({
      ...finding,
      references: finding.references.map((reference) => ({
        ...reference,
        seriesId: frame.seriesId,
        seriesDescription: frame.seriesDescription,
        sliceIndex: frame.sliceIndex,
        fileName: frame.fileName,
        instanceNumber: frame.instanceNumber,
      })),
    })),
    referencedAnnotations: (result.referencedAnnotations as Annotation[]).map((annotation) => ({
      ...annotation,
      seriesId: frame.seriesId,
      sliceIndex: frame.sliceIndex,
    })),
  };
}

function extractJson(text: string, frame: z.infer<typeof currentFrameSchema>): AiAnalysis {
  const raw = extractFirstJsonObject(text);
  if (!raw) {
    throw new AiResponseFormatError('The AI provider returned text instead of the required JSON analysis. Try again, or switch to a model that supports JSON/structured output.');
  }

  try {
    return parseAiAnalysis(JSON.parse(raw), frame);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AiResponseFormatError(`The AI provider returned JSON, but it did not match the ReadMRI analysis format: ${error.issues.map((issue) => issue.path.join('.') || 'root').join(', ')}`);
    }

    throw new AiResponseFormatError('The AI provider returned malformed JSON instead of a valid ReadMRI analysis. Try again, or switch to a model with JSON/structured-output support.');
  }
}

async function readAnalyzeRequest(request: NextRequest): Promise<z.infer<typeof analyzeSchema> | NextResponse> {
  let json: unknown;

  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'The analysis request body was not valid JSON.' }, { status: 400 });
  }

  const body = analyzeSchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  return body.data;
}

export async function POST(request: NextRequest) {
  const payload = await readAnalyzeRequest(request);
  if (payload instanceof NextResponse) return payload;

  const config = providerConfig();
  if (!config.apiKey) {
    const keyName = config.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    return NextResponse.json({ analysis: fallbackAnalysis(`${keyName} is missing for AI_PROVIDER=${config.provider}, so the app returned safe placeholder guidance instead of image interpretation.`) });
  }

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const frame = payload.currentFrame;
  const frameReference = (({ dataUrl, ...image }) => image)(frame);
  const currentFrameAnnotations = payload.annotations.filter((annotation) => annotation.seriesId === frame.seriesId && annotation.sliceIndex === frame.sliceIndex);
  const chatContext = payload.chatHistory.slice(-12).map((message) => ({
    role: message.role,
    text: message.text,
    frame: message.seriesId && typeof message.sliceIndex === 'number' ? `${message.seriesId} slice ${message.sliceIndex + 1}` : 'text-only',
    createdAt: message.createdAt,
  }));

  const responseContract = {
    summary: 'direct chatbot answer about the current frame only',
    safetyNotice: 'string emphasizing educational/non-diagnostic limits',
    structuresChecklist: ankleChecklist,
    findings: [
      {
        region: 'specific anatomy or image pattern visible on the current frame',
        plainLanguage: 'answer the user question in patient-friendly terms',
        whyItMatters: 'why this may matter clinically without diagnosing',
        confidence: 'low | medium | high',
        suggestedFollowUp: 'clinician/radiology follow-up question',
        references: [{ seriesId: frame.seriesId, seriesDescription: frame.seriesDescription, sliceIndex: frame.sliceIndex, fileName: frame.fileName, instanceNumber: frame.instanceNumber, label: 'short current-frame label', x: 50, y: 50, width: 15, height: 15 }],
      },
    ],
    questionsForDoctor: ['string'],
    limitations: ['single-frame limitation, missing adjacent slices, image quality, or uncertainty'],
    referencedAnnotations: [{ id: 'ai-generated id', seriesId: frame.seriesId, sliceIndex: frame.sliceIndex, x: 50, y: 50, width: 15, height: 15, label: 'short callout', note: 'what the AI is pointing at on current frame', color: '#facc15', source: 'ai' }],
  };

  const userText = [
    'Mode: current-frame chat. The AI can visually inspect ONLY the one attached current frame in this request.',
    'Use chat history only as conversation memory, not as visible evidence. If the user asks about another slice/series, tell them to navigate there and ask again.',
    `User question: ${payload.question}`,
    `Current frame metadata: ${JSON.stringify(frameReference)}`,
    `Current series metadata: ${JSON.stringify(payload.series)}`,
    `User annotations on this current frame: ${JSON.stringify(currentFrameAnnotations)}`,
    `Recent chat memory: ${JSON.stringify(chatContext)}`,
    `Return ONLY JSON matching this contract: ${JSON.stringify(responseContract)}`,
    'Every visible-image finding must reference the current frame values exactly. Do not reference any non-current image.',
    'When helpful, add referencedAnnotations with percentage x/y coordinates and optional width/height so the UI can draw yellow callouts on this frame.',
    'Be conservative. A single frame can explain anatomy and visible patterns, but it cannot replace full DICOM stack review, the radiology report, or clinical exam.',
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
              {
                type: 'image_url' as const,
                image_url: { url: frame.dataUrl },
              },
            ],
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 2400,
        response_format: { type: 'json_object' },
      });

      return NextResponse.json({ analysis: extractJson(response.choices[0]?.message.content ?? '{}', frame) });
    }

    const response = await client.responses.create({
      model: config.model,
      input: [
        { role: 'system', content: aiSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            {
              type: 'input_image' as const,
              image_url: frame.dataUrl,
              detail: 'high' as const,
            },
          ],
        },
      ],
      temperature: 0.2,
      max_output_tokens: 2400,
      text: {
        format: {
          type: 'json_schema',
          name: 'readmri_analysis',
          description: 'Patient-friendly educational ankle/foot MRI analysis with slice references and safety limitations.',
          schema: aiAnalysisJsonSchema,
        },
      },
    });

    return NextResponse.json({ analysis: extractJson(response.output_text, frame) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : `${config.provider} failed to analyze the current frame.` },
      { status: 502 },
    );
  }
}
