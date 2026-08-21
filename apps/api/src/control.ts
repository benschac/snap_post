import { randomUUID } from 'node:crypto';

import {
  ClientControlEventSchema,
  CONTROL_PROTOCOL_VERSION,
  ServerControlEventSchema,
  ServerErrorEventSchema,
  type ServerControlEvent,
  type ServerErrorEvent,
} from '@snap/protocol';

type ResponseOptions = {
  eventId?: string;
  revision?: number;
  serverTimestamp?: string;
};

function readEnvelopeValue(
  value: unknown,
  key: 'sessionId' | 'revision',
): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  return Reflect.get(value, key);
}

export function createControlResponse(
  value: unknown,
  options: ResponseOptions = {},
): ServerControlEvent | ServerErrorEvent {
  const parsed = ClientControlEventSchema.safeParse(value);
  const eventId = options.eventId ?? randomUUID();
  const serverTimestamp = options.serverTimestamp ?? new Date().toISOString();

  if (!parsed.success) {
    const sessionId = readEnvelopeValue(value, 'sessionId');
    const revision = readEnvelopeValue(value, 'revision');

    return ServerErrorEventSchema.parse({
      type: 'control.error',
      eventId,
      sessionId:
        typeof sessionId === 'string' && sessionId.length > 0
          ? sessionId
          : 'unknown',
      revision:
        options.revision ??
        (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
          ? revision
          : 0),
      schemaVersion: CONTROL_PROTOCOL_VERSION,
      serverTimestamp,
      payload: {
        code: 'invalid_event',
        message: 'The control event did not match the current protocol.',
      },
    });
  }

  return ServerControlEventSchema.parse({
    type: 'control.pong',
    eventId,
    sessionId: parsed.data.sessionId,
    revision: options.revision ?? parsed.data.revision,
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    serverTimestamp,
    payload: {
      nonce: parsed.data.payload.nonce,
    },
  });
}
