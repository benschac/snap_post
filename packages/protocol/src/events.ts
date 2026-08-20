import { z } from 'zod';

export const CONTROL_PROTOCOL_VERSION = 1 as const;

const IdentifierSchema = z.string().min(1);
const TimestampSchema = z.iso.datetime({ offset: true });
const ConfidenceSchema = z.number().min(0).max(1);
const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/i);

const EventEnvelopeShape = {
  eventId: IdentifierSchema,
  sessionId: IdentifierSchema,
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
};

const ItemEventEnvelopeShape = {
  ...EventEnvelopeShape,
  itemIntentId: IdentifierSchema,
  trackId: IdentifierSchema.optional(),
};

const ClientEventEnvelopeShape = {
  ...ItemEventEnvelopeShape,
  clientTimestamp: TimestampSchema,
};

const ServerEventEnvelopeShape = {
  ...ItemEventEnvelopeShape,
  serverTimestamp: TimestampSchema,
};

export const ProvenanceReferenceSchema = z.object({
  sourceId: IdentifierSchema,
  sourceType: z.enum([
    'user_observation',
    'visual_observation',
    'barcode',
    'ocr',
    'first_party_record',
    'manufacturer',
    'retailer',
    'provider',
  ]),
  url: z.url().optional(),
  observedAt: TimestampSchema.optional(),
});

export const ControlPingEventSchema = z.object({
  ...EventEnvelopeShape,
  type: z.literal('control.ping'),
  clientTimestamp: TimestampSchema,
  payload: z.object({ nonce: IdentifierSchema }),
});

export const SessionStartedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('session.started'),
  payload: z.object({
    deviceId: IdentifierSchema,
    startedAt: TimestampSchema,
  }),
});

export const ItemIntentStartedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('item.intent_started'),
  payload: z.object({
    source: z.enum(['session_start', 'next_item', 'batch_import']),
  }),
});

export const ItemTrackStartedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('item.track_started'),
  trackId: IdentifierSchema,
  payload: z.object({
    capturedAt: TimestampSchema,
    bounds: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().positive().max(1),
      height: z.number().positive().max(1),
    }),
    confidence: ConfidenceSchema,
  }),
});

export const ItemTrackAttachedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('item.track_attached'),
  trackId: IdentifierSchema,
  payload: z.object({ attachedAt: TimestampSchema }),
});

export const FrameSignalEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('frame.signal'),
  payload: z.object({
    capturedAt: TimestampSchema,
    quality: z.object({
      blur: ConfidenceSchema,
      exposure: ConfidenceSchema,
      motion: ConfidenceSchema,
      objectCoverage: ConfidenceSchema,
      occlusion: ConfidenceSchema.optional(),
      overall: ConfidenceSchema,
    }),
  }),
});

const ImageEvidenceShape = {
  imageId: IdentifierSchema,
  capturedAt: TimestampSchema,
  contentType: z.enum(['image/jpeg', 'image/heic', 'image/png', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: Sha256Schema,
};

export const ImageSelectedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('image.selected'),
  payload: z.object({
    ...ImageEvidenceShape,
    role: z.enum(['crop', 'preview', 'full']),
    qualityScore: ConfidenceSchema,
    byteLength: z.number().int().positive().optional(),
  }),
});

export const ImageUploadedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('image.uploaded'),
  payload: z.object({
    imageId: IdentifierSchema,
    objectPath: z.string().min(1),
    uploadedAt: TimestampSchema,
    byteLength: z.number().int().positive(),
    sha256: Sha256Schema,
    etag: z.string().min(1).optional(),
  }),
});

export const BarcodeDetectedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('barcode.detected'),
  payload: z.object({
    format: z.string().min(1),
    rawValue: z.string().min(1),
    confidence: ConfidenceSchema,
  }),
});

export const OcrDetectedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('ocr.detected'),
  payload: z.object({
    text: z.string().min(1),
    confidence: ConfidenceSchema,
    imageId: IdentifierSchema.optional(),
  }),
});

export const EmbeddingReadyEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('embedding.ready'),
  payload: z.object({
    embeddingId: IdentifierSchema,
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
    sourceImageId: IdentifierSchema.optional(),
    contentHash: Sha256Schema,
  }),
});

const AudioEventPayloadShape = {
  utteranceId: IdentifierSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  transcript: z.string(),
  transcriptRevision: z.number().int().nonnegative(),
};

export const AudioPartialEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('audio.partial'),
  payload: z.object(AudioEventPayloadShape),
});

export const AudioFinalEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('audio.final'),
  payload: z.object({
    ...AudioEventPayloadShape,
    endedAt: TimestampSchema,
    interpretation: z.enum(['identity_hint', 'condition_observation', 'description']),
  }),
});

export const ReviewCorrectionEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('review.correction'),
  payload: z.object({
    target: z.enum(['identity', 'transcript', 'image', 'condition', 'price']),
    path: z.string().min(1),
    value: z.json(),
    reason: z.string().min(1).optional(),
  }),
});

export const ItemClosedEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('item.closed'),
  payload: z.object({
    closedAt: TimestampSchema,
    reason: z.enum(['next_item', 'session_stopped']),
    selectedImageIds: z.array(IdentifierSchema),
    weakEvidence: z.boolean(),
  }),
});

export const TaskCancelledEventSchema = z.object({
  ...ClientEventEnvelopeShape,
  type: z.literal('task.cancelled'),
  payload: z.object({
    taskId: IdentifierSchema,
    reason: z.string().min(1),
  }),
});

export const ClientDomainEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  ItemIntentStartedEventSchema,
  ItemTrackStartedEventSchema,
  ItemTrackAttachedEventSchema,
  FrameSignalEventSchema,
  ImageSelectedEventSchema,
  ImageUploadedEventSchema,
  BarcodeDetectedEventSchema,
  OcrDetectedEventSchema,
  EmbeddingReadyEventSchema,
  AudioPartialEventSchema,
  AudioFinalEventSchema,
  ReviewCorrectionEventSchema,
  ItemClosedEventSchema,
  TaskCancelledEventSchema,
]);

export const ClientEventSchema = z.union([
  ControlPingEventSchema,
  ClientDomainEventSchema,
]);

const IdentityCandidatePayloadSchema = z.object({
  candidateId: IdentifierSchema,
  level: z.enum(['category', 'brand_category', 'product_family', 'exact_model']),
  category: z.string().min(1),
  brand: z.string().min(1).optional(),
  productName: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  confidence: ConfidenceSchema,
  provenance: z.array(ProvenanceReferenceSchema),
});

export const IdentityCandidateEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('identity.candidate'),
  payload: IdentityCandidatePayloadSchema,
});

export const IdentityConfirmedEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('identity.confirmed'),
  payload: IdentityCandidatePayloadSchema.extend({
    status: z.enum(['inferred', 'verified', 'conflicted']),
  }),
});

const ClaimPatchSchema = z.object({
  path: z.string().min(1),
  value: z.json(),
  status: z.enum(['observed', 'inferred', 'verified', 'conflicted']),
  confidence: ConfidenceSchema,
  provenance: z.array(ProvenanceReferenceSchema),
});

export const EvidencePatchEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('evidence.patch'),
  payload: z.object({ claims: z.array(ClaimPatchSchema).min(1) }),
});

export const MetadataPatchEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('metadata.patch'),
  payload: z.object({ fields: z.record(z.string(), z.json()) }),
});

export const MarketPatchEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('market.patch'),
  payload: z.object({
    lane: z.enum([
      'current_new_retail',
      'active_used_ask_distribution',
      'verified_sold_comp_distribution',
      'recommended_list_price',
      'expected_transaction_range',
      'quick_sale_price',
    ]),
    currency: z.literal('USD'),
    lowMinor: z.number().int().nonnegative(),
    highMinor: z.number().int().nonnegative(),
    observedAt: TimestampSchema,
    confidence: ConfidenceSchema,
    provenance: z.array(ProvenanceReferenceSchema),
  }),
});

export const ConditionPatchEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('condition.patch'),
  payload: z.object({
    userObservations: z.array(ClaimPatchSchema),
    visualObservations: z.array(ClaimPatchSchema),
    grade: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional(),
  }),
});

export const DraftPatchEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('draft.patch'),
  payload: z.object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    condition: z.string().min(1).optional(),
    priceMinor: z.number().int().nonnegative().optional(),
    currency: z.literal('USD').optional(),
    photoIds: z.array(IdentifierSchema).optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    warnings: z.array(z.string().min(1)).optional(),
  }),
});

export const ReviewFlagEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('review.flag'),
  payload: z.object({
    code: z.string().min(1),
    severity: z.enum(['info', 'warning']),
    message: z.string().min(1),
  }),
});

export const ItemReadyEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('item.ready'),
  payload: z.object({
    readyAt: TimestampSchema,
    status: z.enum(['reviewable', 'missing_evidence']),
    missingEvidence: z.array(z.string().min(1)),
  }),
});

export const TaskFailedEventSchema = z.object({
  ...ServerEventEnvelopeShape,
  type: z.literal('task.failed'),
  payload: z.object({
    taskId: IdentifierSchema,
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});

export const ControlPongEventSchema = z.object({
  ...EventEnvelopeShape,
  type: z.literal('control.pong'),
  serverTimestamp: TimestampSchema,
  payload: z.object({ nonce: IdentifierSchema }),
});

export const ServerErrorEventSchema = z.object({
  ...EventEnvelopeShape,
  type: z.literal('control.error'),
  serverTimestamp: TimestampSchema,
  payload: z.object({
    code: z.enum(['invalid_event', 'unsupported_event']),
    message: z.string().min(1),
  }),
});

export const ServerDomainEventSchema = z.discriminatedUnion('type', [
  IdentityCandidateEventSchema,
  IdentityConfirmedEventSchema,
  EvidencePatchEventSchema,
  MetadataPatchEventSchema,
  MarketPatchEventSchema,
  ConditionPatchEventSchema,
  DraftPatchEventSchema,
  ReviewFlagEventSchema,
  ItemReadyEventSchema,
  TaskFailedEventSchema,
]);

export const ServerEventSchema = z.union([
  ControlPongEventSchema,
  ServerErrorEventSchema,
  ServerDomainEventSchema,
]);

export const HealthResponseSchema = z.object({
  service: z.literal('snap-api'),
  status: z.literal('ok'),
  protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
});

// Compatibility names retained for the initial control-plane scaffold.
export const ClientControlEventSchema = ControlPingEventSchema;
export const ServerControlEventSchema = ControlPongEventSchema;

export type ClientControlEvent = z.infer<typeof ClientControlEventSchema>;
export type ClientDomainEvent = z.infer<typeof ClientDomainEventSchema>;
export type ClientEvent = z.infer<typeof ClientEventSchema>;
export type ServerControlEvent = z.infer<typeof ServerControlEventSchema>;
export type ServerDomainEvent = z.infer<typeof ServerDomainEventSchema>;
export type ServerErrorEvent = z.infer<typeof ServerErrorEventSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
