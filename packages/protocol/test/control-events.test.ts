import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClientEventSchema,
  ClientControlEventSchema,
  CONTROL_PROTOCOL_VERSION,
  EventReceiptSchema,
  ServerEventSchema,
  SessionEventSubscriptionSchema,
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

const domainEnvelope = {
  eventId: 'event-2',
  sessionId: 'session-1',
  itemIntentId: 'item-1',
  trackId: 'track-1',
  revision: 3,
  schemaVersion: CONTROL_PROTOCOL_VERSION,
};

test('accepts a selected image with upload idempotency metadata', () => {
  const event = ClientEventSchema.parse({
    ...domainEnvelope,
    type: 'image.selected',
    clientTimestamp: '2026-08-20T12:00:00.000Z',
    payload: {
      imageId: 'image-1',
      capturedAt: '2026-08-20T11:59:59.000Z',
      contentType: 'image/jpeg',
      width: 640,
      height: 480,
      sha256: 'a'.repeat(64),
      role: 'crop',
      qualityScore: 0.91,
      byteLength: 42_000,
    },
  });

  assert.equal(event.type, 'image.selected');
  assert.equal(event.payload.imageId, 'image-1');
});

test('accepts a claim patch with confidence and provenance', () => {
  const event = ServerEventSchema.parse({
    ...domainEnvelope,
    type: 'evidence.patch',
    serverTimestamp: '2026-08-20T12:00:01.000Z',
    payload: {
      claims: [
        {
          path: 'identity.brand',
          value: 'IKEA',
          status: 'verified',
          confidence: 0.98,
          provenance: [
            {
              sourceId: 'source-1',
              sourceType: 'manufacturer',
              url: 'https://www.ikea.com/example',
              observedAt: '2026-08-20T12:00:00.000Z',
            },
          ],
        },
      ],
    },
  });

  assert.equal(event.type, 'evidence.patch');
  assert.equal(event.payload.claims[0]?.status, 'verified');
});

test('rejects invalid confidence and content hashes', () => {
  const result = ClientEventSchema.safeParse({
    ...domainEnvelope,
    type: 'image.selected',
    clientTimestamp: '2026-08-20T12:00:00.000Z',
    payload: {
      imageId: 'image-1',
      capturedAt: '2026-08-20T11:59:59.000Z',
      contentType: 'image/jpeg',
      width: 640,
      height: 480,
      sha256: 'not-a-hash',
      role: 'crop',
      qualityScore: 1.2,
    },
  });

  assert.equal(result.success, false);
});

test('validates oRPC event receipts and resumable session subscriptions', () => {
  const receipt = EventReceiptSchema.parse({
    eventId: 'event-2',
    receivedAt: '2026-08-20T12:00:01.000Z',
  });
  const subscription = SessionEventSubscriptionSchema.parse({
    sessionId: 'session-1',
    afterRevision: 2,
  });

  assert.equal(receipt.eventId, 'event-2');
  assert.equal(subscription.afterRevision, 2);
  assert.equal(
    SessionEventSubscriptionSchema.safeParse({
      sessionId: 'session-1',
      afterRevision: -1,
    }).success,
    false,
  );
});
