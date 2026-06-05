import OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { aiSystemPrompt, ankleChecklist } from '../../lib/ankleKnowledge';
import type { AiAnalysis } from '../../lib/types';

export const runtime = 'nodejs';

const analyzeSchema = z.object({
  series: z.object({
    description: z.string(),
    sequenceName: z.string().optional(),
    plane: z.string(),
    sliceCount: z.number(),
    metadata: z.record(z.unknown()).optional(),
  }),
  annotations: z.array(z.object({
    label: z.string(),
    note: z.string(),
    sliceIndex: z.number(),
    x: z.number(),
    y: z.number(),
  })).default([]),
  images: z.array(z.object({
    fileName: z.string(),
    instanceNumber: z.number(),
    dataUrl: z.string().startsWith('data:image/png;base64,'),
  })).min(1).max(8),
});

type AiProvider = 'openai' | 'groq';

type ProviderConfig = {
  provider: AiProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
  maxImages: number;
};

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
    maxImages: 8,
  };
}

function fallbackAnalysis(reason: string): AiAnalysis {
  return {
    summary: 'AI image review is not configured yet, but the viewer can still organize series, show slices, and capture annotations/questions for your clinician.',
    safetyNotice: 'Educational support only. This is not a diagnosis and should not replace a radiology report or medical care.',
    structuresChecklist: ankleChecklist,
    findings: [
      {
        region: 'Configuration',
        plainLanguage: reason,
        whyItMatters: 'A medical-image explanation should be generated only when a trusted model is configured and the user understands the limits.',
        confidence: 'low',
        suggestedFollowUp: 'Set AI_PROVIDER=groq with GROQ_API_KEY, or set AI_PROVIDER=openai with OPENAI_API_KEY, then rerun analysis.',
      },
    ],
    questionsForDoctor: [
      'Can you walk me through the radiology report in plain language?',
      'Which structures on the MRI correspond to my pain location?',
      'Do I need immobilization, physical therapy, injections, or surgical evaluation?',
    ],
    limitations: ['No configured AI model reviewed these images.'],
  };
}

function extractJson(text: string): AiAnalysis {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(raw) as Partial<AiAnalysis>;
  return {
    summary: parsed.summary ?? 'The model did not provide a summary.',
    safetyNotice: parsed.safetyNotice ?? 'Educational support only; consult your clinician.',
    structuresChecklist: parsed.structuresChecklist ?? ankleChecklist,
    findings: parsed.findings ?? [],
    questionsForDoctor: parsed.questionsForDoctor ?? [],
    limitations: parsed.limitations ?? [],
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

  const userText = [
    'Explain this ankle/foot MRI series for an educated patient without making a diagnosis.',
    `Series: ${payload.series.description}`,
    `Sequence: ${payload.series.sequenceName || 'not labeled'}`,
    `Plane: ${payload.series.plane}`,
    `Slice count: ${payload.series.sliceCount}`,
    `Metadata: ${JSON.stringify(payload.series.metadata ?? {})}`,
    `User annotations/questions: ${JSON.stringify(payload.annotations)}`,
    'Be conservative. Mention if only one series/sequence is insufficient for many ankle MRI conclusions.',
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
        max_completion_tokens: 1800,
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
      max_output_tokens: 1800,
    });

    return NextResponse.json({ analysis: extractJson(response.output_text) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : `${config.provider} failed to analyze the series.` },
      { status: 502 },
    );
  }
}
