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
        suggestedFollowUp: 'Add OPENAI_API_KEY in Vercel project settings, optionally set AI_MODEL, then rerun analysis.',
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ analysis: fallbackAnalysis('OPENAI_API_KEY is missing, so the app returned safe placeholder guidance instead of image interpretation.') });
  }

  const model = process.env.AI_MODEL ?? 'gpt-4.1';
  const client = new OpenAI({ apiKey });
  const payload = body.data;

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
    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: aiSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            ...payload.images.map((image) => ({
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

    const output = response.output_text;
    return NextResponse.json({ analysis: extractJson(output) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'The AI provider failed to analyze the series.' },
      { status: 502 },
    );
  }
}
