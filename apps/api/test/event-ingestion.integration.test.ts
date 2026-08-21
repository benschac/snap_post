import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  type ControlContractClient,
  CONTROL_PROTOCOL_VERSION,
  type ClientDomainEvent,
} from '@snap/protocol';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { WebSocket } from 'ws';

import { createDatabaseClient } from '../src/database/client.ts';
import {
  EventIdReuseError,
  EventParentNotFoundError,
  persistDomainEvent,
} from '../src/database/event-ingestion.ts';
import {
  controlEvents,
  images,
  itemIntents,
  itemTracks,
  sessions,
} from '../src/database/schema.ts';
import { createApiServer } from '../src/runtime.ts';

const integrationTest =
  process.env.DATABASE_URL === undefined ? test.skip : test;
const timestamp = '2026-08-20T12:00:00.000Z';
const sha256 = 'b'.repeat(64);

function eventBase(prefix: string) {
  return {
    clientTimestamp: timestamp,
    itemIntentId: `${prefix}-item`,
    revision: 0,
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    sessionId: `${prefix}-session`,
  };
}

integrationTest('persists all seven projections and immutable events together', async () => {
  const client = createDatabaseClient();
  const prefix = `ingestion-${randomUUID()}`;
  const base = eventBase(prefix);
  const trackId = `${prefix}-track`;
  const imageId = `${prefix}-image`;
  const events: ClientDomainEvent[] = [
    {
      ...base,
      eventId: `${prefix}-session-started`,
      type: 'session.started',
      payload: { deviceId: 'integration-device', startedAt: timestamp },
    },
    {
      ...base,
      eventId: `${prefix}-intent-started`,
      revision: 1,
      type: 'item.intent_started',
      payload: { source: 'session_start' },
    },
    {
      ...base,
      eventId: `${prefix}-track-started`,
      revision: 2,
      trackId,
      type: 'item.track_started',
      payload: {
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        capturedAt: timestamp,
        confidence: 0.9,
      },
    },
    {
      ...base,
      eventId: `${prefix}-track-attached`,
      revision: 3,
      trackId,
      type: 'item.track_attached',
      payload: { attachedAt: timestamp },
    },
    {
      ...base,
      eventId: `${prefix}-image-selected`,
      revision: 4,
      trackId,
      type: 'image.selected',
      payload: {
        imageId,
        capturedAt: timestamp,
        contentType: 'image/jpeg',
        width: 640,
        height: 480,
        sha256,
        role: 'preview',
        qualityScore: 0.8,
        byteLength: 12_345,
      },
    },
    {
      ...base,
      eventId: `${prefix}-image-uploaded`,
      revision: 5,
      type: 'image.uploaded',
      payload: {
        imageId,
        objectPath: `${prefix}/${imageId}.jpg`,
        uploadedAt: timestamp,
        byteLength: 12_345,
        sha256,
        etag: 'etag-1',
      },
    },
    {
      ...base,
      eventId: `${prefix}-item-closed`,
      revision: 6,
      type: 'item.closed',
      payload: {
        closedAt: timestamp,
        reason: 'next_item',
        selectedImageIds: [imageId],
        weakEvidence: false,
      },
    },
  ];

  try {
    const receipts = [];
    for (const event of events) {
      receipts.push(await persistDomainEvent(client.db, event));
    }

    const retry = await persistDomainEvent(client.db, events[4]!);
    assert.deepEqual(retry, receipts[4]);

    const [session] = await client.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, base.sessionId));
    const [intent] = await client.db
      .select()
      .from(itemIntents)
      .where(eq(itemIntents.id, base.itemIntentId));
    const [track] = await client.db
      .select()
      .from(itemTracks)
      .where(eq(itemTracks.id, trackId));
    const [image] = await client.db
      .select()
      .from(images)
      .where(eq(images.id, imageId));
    const [ledger] = await client.db
      .select({ value: count() })
      .from(controlEvents)
      .where(inArray(controlEvents.id, events.map((event) => event.eventId)));

    assert.equal(new Date(session!.startedAt).toISOString(), timestamp);
    assert.equal(intent?.sequence, 0);
    assert.equal(intent?.status, 'closed');
    assert.equal(new Date(track!.attachedAt!).toISOString(), timestamp);
    assert.equal(image?.objectPath, `${prefix}/${imageId}.jpg`);
    assert.equal(new Date(image!.uploadedAt!).toISOString(), timestamp);
    assert.equal(ledger?.value, 7);
  } finally {
    await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
    await client.close();
  }
});

integrationTest('serializes an identical concurrent event retry', async () => {
  const client = createDatabaseClient();
  const prefix = `concurrent-${randomUUID()}`;
  const base = eventBase(prefix);
  const event = {
    ...base,
    eventId: `${prefix}-event`,
    type: 'session.started' as const,
    payload: { deviceId: 'integration-device', startedAt: timestamp },
  };

  try {
    const [first, second] = await Promise.all([
      persistDomainEvent(client.db, event),
      persistDomainEvent(client.db, event),
    ]);
    assert.deepEqual(second, first);

    const [sessionCount] = await client.db
      .select({ value: count() })
      .from(sessions)
      .where(eq(sessions.id, base.sessionId));
    const [eventCount] = await client.db
      .select({ value: count() })
      .from(controlEvents)
      .where(eq(controlEvents.id, event.eventId));
    assert.equal(sessionCount?.value, 1);
    assert.equal(eventCount?.value, 1);
  } finally {
    await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
    await client.close();
  }
});

integrationTest('allocates item sequence numbers atomically', async () => {
  const client = createDatabaseClient();
  const prefix = `sequence-${randomUUID()}`;
  const base = eventBase(prefix);
  const sessionEvent = {
    ...base,
    eventId: `${prefix}-session`,
    type: 'session.started' as const,
    payload: { deviceId: 'integration-device', startedAt: timestamp },
  };
  const itemEvents = [0, 1].map((index) => ({
    ...base,
    eventId: `${prefix}-item-event-${index}`,
    itemIntentId: `${prefix}-item-${index}`,
    type: 'item.intent_started' as const,
    payload: { source: 'session_start' as const },
  }));

  try {
    await persistDomainEvent(client.db, sessionEvent);
    await Promise.all(
      itemEvents.map((event) => persistDomainEvent(client.db, event)),
    );

    const stored = await client.db
      .select({ sequence: itemIntents.sequence })
      .from(itemIntents)
      .where(eq(itemIntents.sessionId, base.sessionId))
      .orderBy(asc(itemIntents.sequence));
    assert.deepEqual(stored, [{ sequence: 0 }, { sequence: 1 }]);
  } finally {
    await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
    await client.close();
  }
});

integrationTest(
  'returns an oRPC receipt only after the transaction is queryable',
  async (t) => {
    const client = createDatabaseClient();
    const prefix = `orpc-${randomUUID()}`;
    const base = eventBase(prefix);
    const server = createApiServer({
      database: client.db,
      hostname: '127.0.0.1',
      port: 0,
    });
    await once(server, 'listening');
    let socket: WebSocket | undefined;

    t.after(async () => {
      if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
        await once(socket, 'close');
      }
      if (server.listening) {
        server.close();
        await once(server, 'close');
      }
      await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
      await client.close();
    });

    const { port } = server.address() as AddressInfo;
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/control`);
    await once(socket, 'open');

    const rpc: ControlContractClient = createORPCClient(
      new RPCLink({ websocket: socket }),
    );
    const event = {
      ...base,
      eventId: `${prefix}-event`,
      type: 'session.started' as const,
      payload: { deviceId: 'integration-device', startedAt: timestamp },
    };
    const receipt = await rpc.control.publish(event);

    const [storedSession] = await client.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, base.sessionId));
    const [storedEvent] = await client.db
      .select({ id: controlEvents.id })
      .from(controlEvents)
      .where(eq(controlEvents.id, event.eventId));
    assert.equal(receipt.eventId, event.eventId);
    assert.equal(storedSession?.id, base.sessionId);
    assert.equal(storedEvent?.id, event.eventId);
  },
);

integrationTest('rejects mismatched event-ID reuse without changing the projection', async () => {
  const client = createDatabaseClient();
  const prefix = `reuse-${randomUUID()}`;
  const base = eventBase(prefix);
  const event = {
    ...base,
    eventId: `${prefix}-event`,
    type: 'session.started' as const,
    payload: { deviceId: 'original-device', startedAt: timestamp },
  };

  try {
    await persistDomainEvent(client.db, event);
    await assert.rejects(
      persistDomainEvent(client.db, {
        ...event,
        payload: { ...event.payload, deviceId: 'different-device' },
      }),
      EventIdReuseError,
    );
    const [session] = await client.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, base.sessionId));
    assert.equal(session?.deviceId, 'original-device');
  } finally {
    await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
    await client.close();
  }
});

integrationTest('rolls back the ledger when a parent is missing', async () => {
  const client = createDatabaseClient();
  const prefix = `missing-${randomUUID()}`;
  const base = eventBase(prefix);
  const event = {
    ...base,
    eventId: `${prefix}-event`,
    type: 'item.intent_started' as const,
    payload: { source: 'session_start' as const },
  };

  try {
    await assert.rejects(
      persistDomainEvent(client.db, event),
      EventParentNotFoundError,
    );
    const [eventCount] = await client.db
      .select({ value: count() })
      .from(controlEvents)
      .where(eq(controlEvents.id, event.eventId));
    const [intentCount] = await client.db
      .select({ value: count() })
      .from(itemIntents)
      .where(eq(itemIntents.id, base.itemIntentId));
    assert.equal(eventCount?.value, 0);
    assert.equal(intentCount?.value, 0);
  } finally {
    await client.close();
  }
});

integrationTest('rolls back a failed projection before inserting its ledger row', async () => {
  const client = createDatabaseClient();
  const prefix = `rollback-${randomUUID()}`;
  const base = eventBase(prefix);
  const sessionEvent = {
    ...base,
    eventId: `${prefix}-session`,
    type: 'session.started' as const,
    payload: { deviceId: 'integration-device', startedAt: timestamp },
  };
  const intentEvent = {
    ...base,
    eventId: `${prefix}-intent`,
    type: 'item.intent_started' as const,
    payload: { source: 'session_start' as const },
  };
  const firstImage = {
    ...base,
    eventId: `${prefix}-image-1`,
    type: 'image.selected' as const,
    payload: {
      imageId: `${prefix}-image-1`,
      capturedAt: timestamp,
      contentType: 'image/jpeg' as const,
      width: 10,
      height: 10,
      sha256,
      role: 'preview' as const,
      qualityScore: 0.8,
    },
  };
  const conflictingImage = {
    ...firstImage,
    eventId: `${prefix}-image-2`,
    payload: { ...firstImage.payload, imageId: `${prefix}-image-2` },
  };

  try {
    await persistDomainEvent(client.db, sessionEvent);
    await persistDomainEvent(client.db, intentEvent);
    await persistDomainEvent(client.db, firstImage);
    await assert.rejects(persistDomainEvent(client.db, conflictingImage));

    const [conflictingEventCount] = await client.db
      .select({ value: count() })
      .from(controlEvents)
      .where(eq(controlEvents.id, conflictingImage.eventId));
    const [conflictingImageCount] = await client.db
      .select({ value: count() })
      .from(images)
      .where(
        and(
          eq(images.itemIntentId, base.itemIntentId),
          eq(images.id, conflictingImage.payload.imageId),
        ),
      );
    assert.equal(conflictingEventCount?.value, 0);
    assert.equal(conflictingImageCount?.value, 0);
  } finally {
    await client.db.delete(sessions).where(eq(sessions.id, base.sessionId));
    await client.close();
  }
});
