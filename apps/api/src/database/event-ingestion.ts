import { isDeepStrictEqual } from 'node:util';

import type { ClientDomainEvent, EventReceipt } from '@snap/protocol';
import { and, eq, max, sql } from 'drizzle-orm';

import type { Database } from './client.ts';
import {
  controlEvents,
  images,
  itemIntents,
  itemTracks,
  sessions,
  type JsonValue,
  type NewImage,
  type NewItemIntent,
  type NewItemTrack,
  type NewSession,
} from './schema.ts';

type SupportedEventType =
  | 'session.started'
  | 'item.intent_started'
  | 'item.track_started'
  | 'item.track_attached'
  | 'image.selected'
  | 'image.uploaded'
  | 'item.closed';

export type SupportedDomainEvent = Extract<
  ClientDomainEvent,
  { type: SupportedEventType }
>;

export type EventProjection =
  | { kind: 'session.insert'; values: NewSession }
  | {
      kind: 'item_intent.insert';
      values: Omit<NewItemIntent, 'sequence'>;
    }
  | { kind: 'item_track.insert'; values: NewItemTrack }
  | {
      kind: 'item_track.attach';
      itemIntentId: string;
      trackId: string;
      attachedAt: string;
    }
  | { kind: 'image.insert'; values: NewImage }
  | {
      kind: 'image.upload';
      imageId: string;
      itemIntentId: string;
      sha256: string;
      values: {
        byteLength: number;
        etag?: string;
        objectPath: string;
        uploadedAt: string;
      };
    }
  | {
      kind: 'item_intent.close';
      itemIntentId: string;
      sessionId: string;
      values: {
        closedAt: string;
        status: 'closed';
        weakEvidence: boolean;
      };
    };

export class EventIdReuseError extends Error {
  constructor(readonly eventId: string) {
    super(`Event ID ${eventId} was already used for different content`);
    this.name = 'EventIdReuseError';
  }
}

export class EventParentNotFoundError extends Error {
  constructor(readonly eventType: SupportedEventType) {
    super(`A required parent was not found for ${eventType}`);
    this.name = 'EventParentNotFoundError';
  }
}

export class UnsupportedDomainEventError extends Error {
  constructor(readonly eventType: ClientDomainEvent['type']) {
    super(`Event type ${eventType} is not supported by durable ingestion yet`);
    this.name = 'UnsupportedDomainEventError';
  }
}

export function isSupportedDomainEvent(
  event: ClientDomainEvent,
): event is SupportedDomainEvent {
  switch (event.type) {
    case 'session.started':
    case 'item.intent_started':
    case 'item.track_started':
    case 'item.track_attached':
    case 'image.selected':
    case 'image.uploaded':
    case 'item.closed':
      return true;
    default:
      return false;
  }
}

export function createEventProjection(
  event: SupportedDomainEvent,
): EventProjection {
  switch (event.type) {
    case 'session.started':
      return {
        kind: 'session.insert',
        values: {
          id: event.sessionId,
          deviceId: event.payload.deviceId,
          startedAt: event.clientTimestamp,
        },
      };
    case 'item.intent_started':
      return {
        kind: 'item_intent.insert',
        values: {
          id: event.itemIntentId,
          sessionId: event.sessionId,
          source: event.payload.source,
          startedAt: event.clientTimestamp,
        },
      };
    case 'item.track_started':
      return {
        kind: 'item_track.insert',
        values: {
          id: event.trackId,
          itemIntentId: event.itemIntentId,
          confidence: event.payload.confidence,
          startedAt: event.clientTimestamp,
        },
      };
    case 'item.track_attached':
      return {
        kind: 'item_track.attach',
        itemIntentId: event.itemIntentId,
        trackId: event.trackId,
        attachedAt: event.clientTimestamp,
      };
    case 'image.selected':
      return {
        kind: 'image.insert',
        values: {
          id: event.payload.imageId,
          itemIntentId: event.itemIntentId,
          trackId: event.trackId,
          role: event.payload.role,
          contentType: event.payload.contentType,
          width: event.payload.width,
          height: event.payload.height,
          sha256: event.payload.sha256,
          qualityScore: event.payload.qualityScore,
          byteLength: event.payload.byteLength,
          capturedAt: event.clientTimestamp,
        },
      };
    case 'image.uploaded':
      return {
        kind: 'image.upload',
        imageId: event.payload.imageId,
        itemIntentId: event.itemIntentId,
        sha256: event.payload.sha256,
        values: {
          objectPath: event.payload.objectPath,
          uploadedAt: event.clientTimestamp,
          byteLength: event.payload.byteLength,
          etag: event.payload.etag,
        },
      };
    case 'item.closed':
      return {
        kind: 'item_intent.close',
        itemIntentId: event.itemIntentId,
        sessionId: event.sessionId,
        values: {
          status: 'closed',
          closedAt: event.clientTimestamp,
          weakEvidence: event.payload.weakEvidence,
        },
      };
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function requireItemIntent(
  transaction: Transaction,
  event: {
    itemIntentId: string;
    sessionId: string;
    type: SupportedEventType;
  },
): Promise<void> {
  const [itemIntent] = await transaction
    .select({ id: itemIntents.id })
    .from(itemIntents)
    .where(
      and(
        eq(itemIntents.id, event.itemIntentId),
        eq(itemIntents.sessionId, event.sessionId),
      ),
    )
    .limit(1);

  if (itemIntent === undefined) {
    throw new EventParentNotFoundError(event.type);
  }
}

async function requireTrack(
  transaction: Transaction,
  event: {
    itemIntentId: string;
    trackId: string;
    type: SupportedEventType;
  },
): Promise<void> {
  const [track] = await transaction
    .select({ id: itemTracks.id })
    .from(itemTracks)
    .where(
      and(
        eq(itemTracks.id, event.trackId),
        eq(itemTracks.itemIntentId, event.itemIntentId),
      ),
    )
    .limit(1);

  if (track === undefined) {
    throw new EventParentNotFoundError(event.type);
  }
}

async function applyProjection(
  transaction: Transaction,
  event: SupportedDomainEvent,
): Promise<void> {
  const projection = createEventProjection(event);

  switch (projection.kind) {
    case 'session.insert':
      await transaction.insert(sessions).values(projection.values);
      return;
    case 'item_intent.insert': {
      const [session] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, event.sessionId))
        .limit(1)
        .for('update');

      if (session === undefined) {
        throw new EventParentNotFoundError(event.type);
      }

      const [current] = await transaction
        .select({ sequence: max(itemIntents.sequence) })
        .from(itemIntents)
        .where(eq(itemIntents.sessionId, event.sessionId));
      const sequence = (current?.sequence ?? -1) + 1;

      await transaction
        .insert(itemIntents)
        .values({ ...projection.values, sequence });
      return;
    }
    case 'item_track.insert':
      await requireItemIntent(transaction, event);
      await transaction.insert(itemTracks).values(projection.values);
      return;
    case 'item_track.attach': {
      await requireItemIntent(transaction, event);
      const [updated] = await transaction
        .update(itemTracks)
        .set({ attachedAt: projection.attachedAt, updatedAt: sql`now()` })
        .where(
          and(
            eq(itemTracks.id, projection.trackId),
            eq(itemTracks.itemIntentId, projection.itemIntentId),
          ),
        )
        .returning({ id: itemTracks.id });

      if (updated === undefined) {
        throw new EventParentNotFoundError(event.type);
      }
      return;
    }
    case 'image.insert':
      await requireItemIntent(transaction, event);
      if (event.trackId !== undefined) {
        await requireTrack(transaction, { ...event, trackId: event.trackId });
      }
      await transaction.insert(images).values(projection.values);
      return;
    case 'image.upload': {
      await requireItemIntent(transaction, event);
      if (event.trackId !== undefined) {
        await requireTrack(transaction, { ...event, trackId: event.trackId });
      }
      const [updated] = await transaction
        .update(images)
        .set({ ...projection.values, updatedAt: sql`now()` })
        .where(
          and(
            eq(images.id, projection.imageId),
            eq(images.itemIntentId, projection.itemIntentId),
            eq(images.sha256, projection.sha256),
          ),
        )
        .returning({ id: images.id });

      if (updated === undefined) {
        throw new EventParentNotFoundError(event.type);
      }
      return;
    }
    case 'item_intent.close': {
      const [updated] = await transaction
        .update(itemIntents)
        .set({ ...projection.values, updatedAt: sql`now()` })
        .where(
          and(
            eq(itemIntents.id, projection.itemIntentId),
            eq(itemIntents.sessionId, projection.sessionId),
          ),
        )
        .returning({ id: itemIntents.id });

      if (updated === undefined) {
        throw new EventParentNotFoundError(event.type);
      }
      return;
    }
  }
}

export async function persistDomainEvent(
  db: Database,
  event: ClientDomainEvent,
): Promise<EventReceipt> {
  if (!isSupportedDomainEvent(event)) {
    throw new UnsupportedDomainEventError(event.type);
  }

  const eventJson = toJsonValue(event);

  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${event.eventId}, 0))`,
    );

    const [existing] = await transaction
      .select({ event: controlEvents.event, receivedAt: controlEvents.receivedAt })
      .from(controlEvents)
      .where(eq(controlEvents.id, event.eventId))
      .limit(1);

    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.event, eventJson)) {
        throw new EventIdReuseError(event.eventId);
      }
      return {
        eventId: event.eventId,
        receivedAt: toIsoTimestamp(existing.receivedAt),
      };
    }

    await applyProjection(transaction, event);

    const [stored] = await transaction
      .insert(controlEvents)
      .values({
        id: event.eventId,
        sessionId: event.sessionId,
        itemIntentId: event.type === 'session.started' ? null : event.itemIntentId,
        trackId: event.trackId,
        direction: 'client',
        eventType: event.type,
        revision: event.revision,
        schemaVersion: event.schemaVersion,
        occurredAt: event.clientTimestamp,
        event: eventJson,
      })
      .returning({ receivedAt: controlEvents.receivedAt });

    if (stored === undefined) {
      throw new Error(`Failed to store event ${event.eventId}`);
    }

    return {
      eventId: event.eventId,
      receivedAt: toIsoTimestamp(stored.receivedAt),
    };
  });
}
