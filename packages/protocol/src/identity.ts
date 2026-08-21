import { z } from 'zod';

import { IdentityCandidatePayloadSchema } from './events.ts';

const IdentifierSchema = z.string().min(1);
const ConfidenceSchema = z.number().min(0).max(1);
const NullableIdentityTextSchema = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().min(1).nullable(),
);
const VisibleTextSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.length > 0 ? [value] : value),
  z.array(z.string().min(1)).max(20),
);

export const IdentityLevelSchema = z.enum([
  'category',
  'brand_category',
  'product_family',
  'exact_model',
]);

export const IdentifyRequestMetadataSchema = z.object({
  sessionId: IdentifierSchema,
  itemIntentId: IdentifierSchema,
  imageId: IdentifierSchema,
});

export const VisualIdentityInferenceSchema = z.object({
  level: IdentityLevelSchema,
  category: z.string().min(1),
  brand: NullableIdentityTextSchema.default(null),
  productName: NullableIdentityTextSchema.default(null),
  model: NullableIdentityTextSchema.default(null),
  variant: NullableIdentityTextSchema.default(null),
  confidence: ConfidenceSchema,
  visibleText: VisibleTextSchema.default([]),
  visualEvidence: z.array(z.string().min(1)).max(12).optional(),
  alternative: NullableIdentityTextSchema.optional(),
  searchQuery: NullableIdentityTextSchema.default(null),
});

export const IdentifyResponseSchema = z.object({
  requestId: IdentifierSchema,
  sessionId: IdentifierSchema,
  itemIntentId: IdentifierSchema,
  imageId: IdentifierSchema,
  provider: z.object({
    name: z.literal('ai-gateway'),
    model: z.string().min(1),
    latencyMs: z.number().nonnegative(),
  }),
  candidate: IdentityCandidatePayloadSchema,
  signals: z.object({
    visibleText: z.array(z.string().min(1)).max(20),
    visualEvidence: z.array(z.string().min(1)).max(12).optional(),
    alternative: z.string().min(1).optional(),
    imageCount: z.number().int().min(1).max(3).optional(),
    searchQuery: z.string().min(1).optional(),
  }),
});

export const IdentifyErrorResponseSchema = z.object({
  error: z.enum([
    'invalid_request',
    'image_too_large',
    'provider_unconfigured',
    'provider_busy',
    'session_request_limit',
    'provider_timeout',
    'provider_error',
  ]),
  message: z.string().min(1),
});

export const IdentifyStreamAcceptedSchema = z.object({
  type: z.literal('accepted'),
  acceptedAt: z.iso.datetime({ offset: true }),
  request: IdentifyRequestMetadataSchema,
});

export const IdentifyStreamResultSchema = z.object({
  type: z.literal('result'),
  response: IdentifyResponseSchema,
});

export const IdentifyStreamErrorSchema = z.object({
  type: z.literal('error'),
  error: IdentifyErrorResponseSchema,
});

export const IdentifyStreamEventSchema = z.discriminatedUnion('type', [
  IdentifyStreamAcceptedSchema,
  IdentifyStreamResultSchema,
  IdentifyStreamErrorSchema,
]);

export type IdentifyRequestMetadata = z.infer<
  typeof IdentifyRequestMetadataSchema
>;
export type VisualIdentityInference = z.infer<
  typeof VisualIdentityInferenceSchema
>;
export type IdentifyResponse = z.infer<typeof IdentifyResponseSchema>;
export type IdentifyErrorResponse = z.infer<typeof IdentifyErrorResponseSchema>;
export type IdentifyStreamEvent = z.infer<typeof IdentifyStreamEventSchema>;
