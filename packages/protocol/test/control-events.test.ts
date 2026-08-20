import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClientControlEventSchema,
  CONTROL_PROTOCOL_VERSION,
} from '../src/index.ts';

test('accepts a versioned control ping', () => {
  const event = ClientControlEventSchema.parse({
    type: 'control.ping',
    eventId: 'event-1',
    sessionId: 'session-1',
    revision: 0,
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    clientTimestamp: '2026-08-20T12:00:00.000Z',
    payload: { nonce: 'nonce-1' },
  });

  assert.equal(event.payload.nonce, 'nonce-1');
});

test('rejects an unsupported protocol version', () => {
  const result = ClientControlEventSchema.safeParse({
    type: 'control.ping',
    eventId: 'event-1',
    sessionId: 'session-1',
    revision: 0,
    schemaVersion: 2,
    clientTimestamp: '2026-08-20T12:00:00.000Z',
    payload: { nonce: 'nonce-1' },
  });

  assert.equal(result.success, false);
});
