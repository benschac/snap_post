import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_PROTOCOL_VERSION } from '@snap/protocol';

import {
  createEventProjection,
  type SupportedDomainEvent,
} from '../src/database/event-ingestion.ts';

const base = {
  clientTimestamp: '2026-08-20T12:00:01.000Z',
  eventId: 'event-1',
  itemIntentId: 'item-1',
  revision: 1,
  schemaVersion: CONTROL_PROTOCOL_VERSION,
  sessionId: 'session-1',
};
const sha256 = 'a'.repeat(64);

const cases: Array<{
  event: SupportedDomainEvent;
  expected: ReturnType<typeof createEventProjection>;
}> = [
  {
    event: {
      ...base,
      type: 'session.started',
      payload: {
        deviceId: 'device-1',
        startedAt: '2026-08-20T12:00:00.000Z',
      },
    },
    expected: {
      kind: 'session.insert',
      values: {
        id: 'session-1',
        deviceId: 'device-1',
        startedAt: base.clientTimestamp,
      },
    },
  },
  {
    event: {
      ...base,
      type: 'item.intent_started',
      payload: { source: 'session_start' },
    },
    expected: {
      kind: 'item_intent.insert',
      values: {
        id: 'item-1',
        sessionId: 'session-1',
        source: 'session_start',
        startedAt: base.clientTimestamp,
      },
    },
  },
  {
    event: {
      ...base,
      type: 'item.track_started',
      trackId: 'track-1',
      payload: {
        bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        capturedAt: '2026-08-20T12:00:00.500Z',
        confidence: 0.9,
      },
    },
    expected: {
      kind: 'item_track.insert',
      values: {
        id: 'track-1',
        itemIntentId: 'item-1',
        confidence: 0.9,
        startedAt: base.clientTimestamp,
      },
    },
  },
  {
    event: {
      ...base,
      type: 'item.track_attached',
      trackId: 'track-1',
      payload: { attachedAt: '2026-08-20T12:00:00.750Z' },
    },
    expected: {
      kind: 'item_track.attach',
      itemIntentId: 'item-1',
      trackId: 'track-1',
      attachedAt: base.clientTimestamp,
    },
  },
  {
    event: {
      ...base,
      type: 'image.selected',
      trackId: 'track-1',
      payload: {
        imageId: 'image-1',
        capturedAt: '2026-08-20T12:00:00.900Z',
        contentType: 'image/jpeg',
        width: 640,
        height: 480,
        sha256,
        role: 'preview',
        qualityScore: 0.8,
        byteLength: 12_345,
      },
    },
    expected: {
      kind: 'image.insert',
      values: {
        id: 'image-1',
        itemIntentId: 'item-1',
        trackId: 'track-1',
        role: 'preview',
        contentType: 'image/jpeg',
        width: 640,
        height: 480,
        sha256,
        qualityScore: 0.8,
        byteLength: 12_345,
        capturedAt: base.clientTimestamp,
      },
    },
  },
  {
    event: {
      ...base,
      type: 'image.uploaded',
      payload: {
        imageId: 'image-1',
        objectPath: 'session-1/image-1.jpg',
        uploadedAt: '2026-08-20T12:00:00.950Z',
        byteLength: 12_345,
        sha256,
        etag: 'etag-1',
      },
    },
    expected: {
      kind: 'image.upload',
      imageId: 'image-1',
      itemIntentId: 'item-1',
      sha256,
      values: {
        objectPath: 'session-1/image-1.jpg',
        uploadedAt: base.clientTimestamp,
        byteLength: 12_345,
        etag: 'etag-1',
      },
    },
  },
  {
    event: {
      ...base,
      type: 'item.closed',
      payload: {
        closedAt: '2026-08-20T12:00:02.000Z',
        reason: 'next_item',
        selectedImageIds: ['image-1'],
        weakEvidence: true,
      },
    },
    expected: {
      kind: 'item_intent.close',
      itemIntentId: 'item-1',
      sessionId: 'session-1',
      values: {
        status: 'closed',
        closedAt: base.clientTimestamp,
        weakEvidence: true,
      },
    },
  },
];

for (const { event, expected } of cases) {
  test(`maps ${event.type} to its projection`, () => {
    assert.deepEqual(createEventProjection(event), expected);
  });
}
