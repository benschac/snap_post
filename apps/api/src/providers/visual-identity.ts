import {
  type VisualIdentityInference,
  VisualIdentityInferenceSchema,
} from '@snap/protocol';
import {
  gateway,
  Output,
  streamText,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';

const DEFAULT_IDENTITY_MODEL = 'google/gemini-3.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_INPUT_IMAGES = 3;

const IDENTITY_PROMPT = `Identify the single resale item shown across these images. All images are different views of the same physical item. Compare the views before deciding.

Inspect only visible evidence such as branding, readable text, control/button layout, ports, proportions, materials, distinctive panels or touch surfaces, and model markings. For visually confusable products, explicitly compare the strongest plausible alternative.

Return one structured result with exactly two top-level objects, in this order:
- candidate: the fast identity fields below
- signals: the slower supporting signals below

candidate fields:
- level: one of category, brand_category, product_family, exact_model
- category: a concise generic product category
- brand: visible or strongly supported brand, otherwise null
- productName: supported product family/name, otherwise null
- model: exact model only when visible or uniquely supported, otherwise null
- variant: size, color, generation, or configuration only when supported, otherwise null
- confidence: number from 0 to 1 reflecting the specificity returned

signals fields:
- visibleText: up to 20 useful words or short text fragments actually visible
- visualEvidence: up to 12 concise visible features that support or contradict the identity
- alternative: the strongest plausible competing product identity, otherwise null
- searchQuery: a concise web-search query using only supported identity clues, otherwise null

Do not invent a manufacturer, model, generation, or variant. Prefer a less-specific level when the images do not support an exact identity. Confidence of 0.9 or higher requires either readable identifying text or at least two distinctive, mutually consistent visual features. If a strong alternative remains, reduce confidence.`;

const VisualIdentityCandidateSchema = VisualIdentityInferenceSchema.pick({
  level: true,
  category: true,
  brand: true,
  productName: true,
  model: true,
  variant: true,
  confidence: true,
});
const VisualIdentitySignalsSchema = VisualIdentityInferenceSchema.pick({
  visibleText: true,
  visualEvidence: true,
  alternative: true,
  searchQuery: true,
});
const VisualIdentityGenerationSchema = z.object({
  candidate: VisualIdentityCandidateSchema,
  signals: VisualIdentitySignalsSchema,
});

export type VisualIdentityImageInput = {
  contentType: 'image/jpeg';
  imageBytes: Uint8Array;
};

export type VisualIdentityResult = {
  inference: VisualIdentityInference;
  latencyMs: number;
  model: string;
  partialLatencyMs?: number;
  reportedConfidence?: number;
  requestId: string;
};

export type VisualIdentityErrorCode =
  | 'provider_unconfigured'
  | 'provider_timeout'
  | 'provider_error';

export class VisualIdentityError extends Error {
  readonly code: VisualIdentityErrorCode;

  constructor(code: VisualIdentityErrorCode, message: string) {
    super(message);
    this.name = 'VisualIdentityError';
    this.code = code;
  }
}

export type VisualIdentityOptions = {
  model?: string;
  onPartialInference?: (inference: VisualIdentityInference) => void;
  timeoutMs?: number;
};

type VisualIdentityDependencies = {
  languageModel?: LanguageModel;
};

export function applyIdentityConfidenceGuardrails(
  inference: VisualIdentityInference,
  imageCount: number,
): VisualIdentityInference {
  if (inference.level === 'category') return inference;

  const hasReadableIdentifier = inference.visibleText.length > 0;
  const visualEvidenceCount = inference.visualEvidence?.length ?? 0;
  let maximumConfidence = 1;

  if (!hasReadableIdentifier && visualEvidenceCount < 2) {
    maximumConfidence = 0.65;
  } else if (imageCount === 1 && !hasReadableIdentifier) {
    maximumConfidence = 0.8;
  }
  if (inference.alternative) {
    maximumConfidence = Math.min(maximumConfidence, 0.85);
  }

  return {
    ...inference,
    confidence: Math.min(inference.confidence, maximumConfidence),
  };
}

function hasGatewayCredentials() {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN,
  );
}

function schemaIssueSummary(
  result: ReturnType<typeof VisualIdentityInferenceSchema.safeParse>,
) {
  if (result.success) return undefined;
  return result.error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

function responseRequestId(response: {
  headers?: Record<string, string>;
  id?: string;
}) {
  const headers = response.headers;
  return (
    headers?.['x-request-id'] ??
    headers?.['x-vercel-id'] ??
    headers?.['x-ai-gateway-request-id'] ??
    response.id ??
    crypto.randomUUID()
  );
}

export async function identifyVisualItem(
  input: { images: readonly VisualIdentityImageInput[] },
  options: VisualIdentityOptions = {},
  dependencies: VisualIdentityDependencies = {},
): Promise<VisualIdentityResult> {
  if (!dependencies.languageModel && !hasGatewayCredentials()) {
    throw new VisualIdentityError(
      'provider_unconfigured',
      'AI Gateway is not configured on the API server',
    );
  }

  const configuredModel =
    options.model ?? process.env.IDENTITY_MODEL ?? DEFAULT_IDENTITY_MODEL;
  if (input.images.length === 0 || input.images.length > MAX_INPUT_IMAGES) {
    throw new VisualIdentityError(
      'provider_error',
      `Visual identity requires between 1 and ${MAX_INPUT_IMAGES} images`,
    );
  }

  const timeoutMs = options.timeoutMs ??
    Number(process.env.IDENTITY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const startedAt = performance.now();

  try {
    const result = streamText({
      model: dependencies.languageModel ?? gateway(configuredModel),
      output: Output.object({ schema: VisualIdentityGenerationSchema }),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: IDENTITY_PROMPT },
            ...input.images.map((image) => ({
              type: 'file' as const,
              data: image.imageBytes,
              mediaType: image.contentType,
            })),
          ],
        },
      ],
      reasoning: 'minimal',
      maxOutputTokens: 800,
      maxRetries: 0,
      abortSignal: controller.signal,
    });

    let emittedPartialIdentity = false;
    let partialLatencyMs: number | undefined;
    for await (const partial of result.partialOutputStream) {
      if (
        emittedPartialIdentity ||
        !Object.hasOwn(partial, 'signals') ||
        !partial.candidate
      ) {
        continue;
      }

      const parsedCandidate = VisualIdentityCandidateSchema.safeParse(
        partial.candidate,
      );
      if (!parsedCandidate.success) continue;
      const parsedPartial = VisualIdentityInferenceSchema.safeParse({
        ...parsedCandidate.data,
        searchQuery: null,
        visibleText: [],
      });
      if (!parsedPartial.success) continue;

      const guardedPartial = applyIdentityConfidenceGuardrails(
        parsedPartial.data,
        input.images.length,
      );
      emittedPartialIdentity = true;
      partialLatencyMs = performance.now() - startedAt;
      options.onPartialInference?.(guardedPartial);
    }

    const latencyMs = performance.now() - startedAt;
    const generated = await result.output;
    const parsedInference = VisualIdentityInferenceSchema.safeParse({
      ...generated.candidate,
      ...generated.signals,
    });
    if (!parsedInference.success) {
      throw new VisualIdentityError(
        'provider_error',
        `Visual identity response did not match the identity schema (${schemaIssueSummary(parsedInference)})`,
      );
    }
    const response = await result.response;

    return {
      inference: applyIdentityConfidenceGuardrails(
        parsedInference.data,
        input.images.length,
      ),
      latencyMs,
      model: response.modelId || configuredModel,
      partialLatencyMs,
      reportedConfidence: parsedInference.data.confidence,
      requestId: responseRequestId(response),
    };
  } catch (error) {
    if (error instanceof VisualIdentityError) throw error;
    if (controller.signal.aborted) {
      throw new VisualIdentityError(
        'provider_timeout',
        `Visual identity request timed out after ${effectiveTimeoutMs} ms`,
      );
    }
    throw new VisualIdentityError(
      'provider_error',
      error instanceof Error
        ? `Visual identity request failed: ${error.message.slice(0, 300)}`
        : 'Visual identity request failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}
