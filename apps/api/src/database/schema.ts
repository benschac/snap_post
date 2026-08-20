import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SessionStatus = 'active' | 'stopped' | 'completed' | 'failed';
export type ItemIntentStatus = 'active' | 'closed' | 'ready' | 'failed';
export type ItemIntentSource =
  | 'session_start'
  | 'next_item'
  | 'batch_import';
export type ImageRole = 'crop' | 'preview' | 'full';
export type ControlEventDirection = 'client' | 'server';
export type ClaimStatus =
  | 'observed'
  | 'inferred'
  | 'verified'
  | 'conflicted';
export type EvidenceSourceType =
  | 'user_observation'
  | 'visual_observation'
  | 'barcode'
  | 'ocr'
  | 'first_party_record'
  | 'manufacturer'
  | 'retailer'
  | 'provider';
export type ProvenanceReference = {
  sourceId: string;
  sourceType: EvidenceSourceType;
  url?: string;
  observedAt?: string;
};
export type PriceLane =
  | 'msrp_at_launch'
  | 'current_new_retail'
  | 'active_used_ask_distribution'
  | 'verified_sold_comp_distribution'
  | 'first_party_historical_ask_distribution'
  | 'first_party_offer_distribution'
  | 'first_party_counteroffer_distribution'
  | 'first_party_agreed_price_distribution'
  | 'first_party_historical_sale_distribution'
  | 'recommended_list_price'
  | 'expected_transaction_range'
  | 'quick_sale_price';

const createdAt = () =>
  timestamp('created_at', { mode: 'string', withTimezone: true })
    .defaultNow()
    .notNull();

const updatedAt = () =>
  timestamp('updated_at', { mode: 'string', withTimezone: true })
    .defaultNow()
    .notNull();

const occurredAt = (name: string) =>
  timestamp(name, { mode: 'string', withTimezone: true });

export const snapToPost = pgSchema('snap_to_post');

/** One continuous camera-and-voice intake session on a single device. */
export const sessions = snapToPost.table(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    deviceId: text('device_id').notNull(),
    status: text('status').$type<SessionStatus>().default('active').notNull(),
    startedAt: occurredAt('started_at').notNull(),
    stoppedAt: occurredAt('stopped_at'),
    completedAt: occurredAt('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'sessions_status_check',
      sql`${table.status} in ('active', 'stopped', 'completed', 'failed')`,
    ),
    index('sessions_device_id_started_at_idx').on(
      table.deviceId,
      table.startedAt,
    ),
  ],
).enableRLS();

/** A provisional or visually attached item being resolved within a session. */
export const itemIntents = snapToPost.table(
  'item_intents',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    sequence: integer('sequence').notNull(),
    source: text('source').$type<ItemIntentSource>().notNull(),
    status: text('status')
      .$type<ItemIntentStatus>()
      .default('active')
      .notNull(),
    weakEvidence: boolean('weak_evidence').default(false).notNull(),
    startedAt: occurredAt('started_at').notNull(),
    closedAt: occurredAt('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('item_intents_sequence_check', sql`${table.sequence} >= 0`),
    check(
      'item_intents_source_check',
      sql`${table.source} in ('session_start', 'next_item', 'batch_import')`,
    ),
    check(
      'item_intents_status_check',
      sql`${table.status} in ('active', 'closed', 'ready', 'failed')`,
    ),
    uniqueIndex('item_intents_session_id_sequence_unique').on(
      table.sessionId,
      table.sequence,
    ),
    index('item_intents_session_id_status_idx').on(
      table.sessionId,
      table.status,
    ),
  ],
).enableRLS();

/** A stable visual track attached to one item intent. */
export const itemTracks = snapToPost.table(
  'item_tracks',
  {
    id: text('id').primaryKey().notNull(),
    itemIntentId: text('item_intent_id')
      .references(() => itemIntents.id, { onDelete: 'cascade' })
      .notNull(),
    confidence: real('confidence').notNull(),
    startedAt: occurredAt('started_at').notNull(),
    attachedAt: occurredAt('attached_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'item_tracks_confidence_check',
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index('item_tracks_item_intent_id_started_at_idx').on(
      table.itemIntentId,
      table.startedAt,
    ),
  ],
).enableRLS();

/** Selected visual evidence and its eventual private object-storage receipt. */
export const images = snapToPost.table(
  'images',
  {
    id: text('id').primaryKey().notNull(),
    itemIntentId: text('item_intent_id')
      .references(() => itemIntents.id, { onDelete: 'cascade' })
      .notNull(),
    trackId: text('track_id').references(() => itemTracks.id, {
      onDelete: 'set null',
    }),
    role: text('role').$type<ImageRole>().notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sha256: text('sha256').notNull(),
    qualityScore: real('quality_score').notNull(),
    byteLength: integer('byte_length'),
    capturedAt: occurredAt('captured_at').notNull(),
    objectPath: text('object_path').unique(),
    uploadedAt: occurredAt('uploaded_at'),
    etag: text('etag'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'images_role_check',
      sql`${table.role} in ('crop', 'preview', 'full')`,
    ),
    check(
      'images_content_type_check',
      sql`${table.contentType} in ('image/jpeg', 'image/heic', 'image/png', 'image/webp')`,
    ),
    check('images_width_check', sql`${table.width} > 0`),
    check('images_height_check', sql`${table.height} > 0`),
    check(
      'images_sha256_check',
      sql`${table.sha256} ~ '^[0-9a-fA-F]{64}$'`,
    ),
    check(
      'images_quality_score_check',
      sql`${table.qualityScore} >= 0 and ${table.qualityScore} <= 1`,
    ),
    check(
      'images_byte_length_check',
      sql`${table.byteLength} is null or ${table.byteLength} > 0`,
    ),
    uniqueIndex('images_item_intent_id_sha256_unique').on(
      table.itemIntentId,
      table.sha256,
    ),
    index('images_item_intent_id_captured_at_idx').on(
      table.itemIntentId,
      table.capturedAt,
    ),
    index('images_track_id_idx').on(table.trackId),
  ],
).enableRLS();

/** Immutable protocol events; the primary key is the idempotency boundary. */
export const controlEvents = snapToPost.table(
  'control_events',
  {
    id: text('id').primaryKey().notNull(),
    sessionId: text('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    itemIntentId: text('item_intent_id').references(() => itemIntents.id, {
      onDelete: 'cascade',
    }),
    trackId: text('track_id').references(() => itemTracks.id, {
      onDelete: 'set null',
    }),
    direction: text('direction').$type<ControlEventDirection>().notNull(),
    eventType: text('event_type').notNull(),
    revision: integer('revision').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    occurredAt: occurredAt('occurred_at').notNull(),
    event: jsonb('event').$type<JsonValue>().notNull(),
    receivedAt: occurredAt('received_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'control_events_direction_check',
      sql`${table.direction} in ('client', 'server')`,
    ),
    check('control_events_revision_check', sql`${table.revision} >= 0`),
    check(
      'control_events_schema_version_check',
      sql`${table.schemaVersion} > 0`,
    ),
    index('control_events_session_id_received_at_idx').on(
      table.sessionId,
      table.receivedAt,
    ),
    index('control_events_item_intent_id_revision_idx').on(
      table.itemIntentId,
      table.revision,
    ),
    index('control_events_track_id_idx').on(table.trackId),
  ],
).enableRLS();

/** A concrete provenance record used to support one or more claims. */
export const evidenceSources = snapToPost.table(
  'evidence_sources',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    itemIntentId: text('item_intent_id')
      .references(() => itemIntents.id, { onDelete: 'cascade' })
      .notNull(),
    sourceId: text('source_id').notNull(),
    sourceType: text('source_type').$type<EvidenceSourceType>().notNull(),
    url: text('url'),
    observedAt: occurredAt('observed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'evidence_sources_source_type_check',
      sql`${table.sourceType} in ('user_observation', 'visual_observation', 'barcode', 'ocr', 'first_party_record', 'manufacturer', 'retailer', 'provider')`,
    ),
    uniqueIndex('evidence_sources_item_intent_id_source_id_unique').on(
      table.itemIntentId,
      table.sourceId,
    ),
    index('evidence_sources_item_intent_id_observed_at_idx').on(
      table.itemIntentId,
      table.observedAt,
    ),
  ],
).enableRLS();

/** One immutable revision of a structured item fact or observation. */
export const claims = snapToPost.table(
  'claims',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    itemIntentId: text('item_intent_id')
      .references(() => itemIntents.id, { onDelete: 'cascade' })
      .notNull(),
    path: text('path').notNull(),
    value: jsonb('value').$type<JsonValue>().notNull(),
    status: text('status').$type<ClaimStatus>().notNull(),
    confidence: real('confidence').notNull(),
    revision: integer('revision').notNull(),
    observedAt: occurredAt('observed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'claims_status_check',
      sql`${table.status} in ('observed', 'inferred', 'verified', 'conflicted')`,
    ),
    check(
      'claims_confidence_check',
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    check('claims_revision_check', sql`${table.revision} >= 0`),
    uniqueIndex('claims_item_intent_id_path_revision_unique').on(
      table.itemIntentId,
      table.path,
      table.revision,
    ),
    index('claims_item_intent_id_status_idx').on(
      table.itemIntentId,
      table.status,
    ),
  ],
).enableRLS();

/** Many-to-many provenance links without coupling a claim to one source. */
export const claimEvidenceSources = snapToPost.table(
  'claim_evidence_sources',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    claimId: uuid('claim_id')
      .references(() => claims.id, { onDelete: 'cascade' })
      .notNull(),
    evidenceSourceId: uuid('evidence_source_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('claim_evidence_sources_claim_id_source_id_unique').on(
      table.claimId,
      table.evidenceSourceId,
    ),
    index('claim_evidence_sources_evidence_source_id_idx').on(
      table.evidenceSourceId,
    ),
    foreignKey({
      columns: [table.evidenceSourceId],
      foreignColumns: [evidenceSources.id],
      name: 'claim_evidence_sources_source_id_fk',
    }).onDelete('cascade'),
  ],
).enableRLS();

/** A timestamped price lane; factual observations stay separate from recommendations. */
export const priceObservations = snapToPost.table(
  'price_observations',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    itemIntentId: text('item_intent_id')
      .references(() => itemIntents.id, { onDelete: 'cascade' })
      .notNull(),
    lane: text('lane').$type<PriceLane>().notNull(),
    currency: text('currency').notNull(),
    lowMinor: integer('low_minor').notNull(),
    highMinor: integer('high_minor').notNull(),
    condition: text('condition').notNull(),
    geography: text('geography').notNull(),
    sampleSize: integer('sample_size').notNull(),
    confidence: real('confidence').notNull(),
    provenance: jsonb('provenance')
      .$type<ProvenanceReference[]>()
      .notNull(),
    observedAt: occurredAt('observed_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'price_observations_lane_check',
      sql`${table.lane} in ('msrp_at_launch', 'current_new_retail', 'active_used_ask_distribution', 'verified_sold_comp_distribution', 'first_party_historical_ask_distribution', 'first_party_offer_distribution', 'first_party_counteroffer_distribution', 'first_party_agreed_price_distribution', 'first_party_historical_sale_distribution', 'recommended_list_price', 'expected_transaction_range', 'quick_sale_price')`,
    ),
    check(
      'price_observations_currency_check',
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check('price_observations_low_minor_check', sql`${table.lowMinor} >= 0`),
    check(
      'price_observations_range_check',
      sql`${table.highMinor} >= ${table.lowMinor}`,
    ),
    check(
      'price_observations_sample_size_check',
      sql`${table.sampleSize} > 0`,
    ),
    check(
      'price_observations_confidence_check',
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index('price_observations_item_intent_id_lane_observed_at_idx').on(
      table.itemIntentId,
      table.lane,
      table.observedAt,
    ),
  ],
).enableRLS();

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ItemIntent = typeof itemIntents.$inferSelect;
export type NewItemIntent = typeof itemIntents.$inferInsert;
export type ItemTrack = typeof itemTracks.$inferSelect;
export type NewItemTrack = typeof itemTracks.$inferInsert;
export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type ControlEvent = typeof controlEvents.$inferSelect;
export type NewControlEvent = typeof controlEvents.$inferInsert;
export type EvidenceSource = typeof evidenceSources.$inferSelect;
export type NewEvidenceSource = typeof evidenceSources.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type PriceObservation = typeof priceObservations.$inferSelect;
export type NewPriceObservation = typeof priceObservations.$inferInsert;
