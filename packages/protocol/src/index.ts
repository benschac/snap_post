import { z } from 'zod';

export const CONTROL_PROTOCOL_VERSION = 1 as const;

const EventIdSchema = z.string().min(1);
const SessionIdSchema = z.string().min(1);
const TimestampSchema = z.iso.datetime({ offset: true });

const EventEnvelopeSchema = z.object({
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
});

export const ClientControlEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('control.ping'),
  clientTimestamp: TimestampSchema,
  payload: z.object({
    nonce: z.string().min(1),
  }),
});

export const ServerControlEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('control.pong'),
  serverTimestamp: TimestampSchema,
  payload: z.object({
    nonce: z.string().min(1),
  }),
});

export const ServerErrorEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('control.error'),
  serverTimestamp: TimestampSchema,
  payload: z.object({
    code: z.enum(['invalid_event', 'unsupported_event']),
    message: z.string().min(1),
  }),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerControlEventSchema,
  ServerErrorEventSchema,
]);

export const HealthResponseSchema = z.object({
  service: z.literal('snap-api'),
  status: z.literal('ok'),
  protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
});

export type ClientControlEvent = z.infer<typeof ClientControlEventSchema>;
export type ServerControlEvent = z.infer<typeof ServerControlEventSchema>;
export type ServerErrorEvent = z.infer<typeof ServerErrorEventSchema>;
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
