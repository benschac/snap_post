CREATE SCHEMA "snap_to_post";
--> statement-breakpoint
CREATE TABLE "snap_to_post"."claim_evidence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"evidence_source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."claim_evidence_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_intent_id" text NOT NULL,
	"path" text NOT NULL,
	"value" jsonb NOT NULL,
	"status" text NOT NULL,
	"confidence" real NOT NULL,
	"revision" integer NOT NULL,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_status_check" CHECK ("snap_to_post"."claims"."status" in ('observed', 'inferred', 'verified', 'conflicted')),
	CONSTRAINT "claims_confidence_check" CHECK ("snap_to_post"."claims"."confidence" >= 0 and "snap_to_post"."claims"."confidence" <= 1),
	CONSTRAINT "claims_revision_check" CHECK ("snap_to_post"."claims"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."control_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"item_intent_id" text,
	"track_id" text,
	"direction" text NOT NULL,
	"event_type" text NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_events_direction_check" CHECK ("snap_to_post"."control_events"."direction" in ('client', 'server')),
	CONSTRAINT "control_events_revision_check" CHECK ("snap_to_post"."control_events"."revision" >= 0),
	CONSTRAINT "control_events_schema_version_check" CHECK ("snap_to_post"."control_events"."schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."control_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."evidence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_intent_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"url" text,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_sources_source_type_check" CHECK ("snap_to_post"."evidence_sources"."source_type" in ('user_observation', 'visual_observation', 'barcode', 'ocr', 'first_party_record', 'manufacturer', 'retailer', 'provider'))
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."evidence_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."images" (
	"id" text PRIMARY KEY NOT NULL,
	"item_intent_id" text NOT NULL,
	"track_id" text,
	"role" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"quality_score" real NOT NULL,
	"byte_length" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"object_path" text,
	"uploaded_at" timestamp with time zone,
	"etag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "images_object_path_unique" UNIQUE("object_path"),
	CONSTRAINT "images_role_check" CHECK ("snap_to_post"."images"."role" in ('crop', 'preview', 'full')),
	CONSTRAINT "images_content_type_check" CHECK ("snap_to_post"."images"."content_type" in ('image/jpeg', 'image/heic', 'image/png', 'image/webp')),
	CONSTRAINT "images_width_check" CHECK ("snap_to_post"."images"."width" > 0),
	CONSTRAINT "images_height_check" CHECK ("snap_to_post"."images"."height" > 0),
	CONSTRAINT "images_sha256_check" CHECK ("snap_to_post"."images"."sha256" ~ '^[0-9a-fA-F]{64}$'),
	CONSTRAINT "images_quality_score_check" CHECK ("snap_to_post"."images"."quality_score" >= 0 and "snap_to_post"."images"."quality_score" <= 1),
	CONSTRAINT "images_byte_length_check" CHECK ("snap_to_post"."images"."byte_length" is null or "snap_to_post"."images"."byte_length" > 0)
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."item_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"weak_evidence" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_intents_sequence_check" CHECK ("snap_to_post"."item_intents"."sequence" >= 0),
	CONSTRAINT "item_intents_source_check" CHECK ("snap_to_post"."item_intents"."source" in ('session_start', 'next_item', 'batch_import')),
	CONSTRAINT "item_intents_status_check" CHECK ("snap_to_post"."item_intents"."status" in ('active', 'closed', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."item_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."item_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"item_intent_id" text NOT NULL,
	"confidence" real NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_tracks_confidence_check" CHECK ("snap_to_post"."item_tracks"."confidence" >= 0 and "snap_to_post"."item_tracks"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."item_tracks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_intent_id" text NOT NULL,
	"lane" text NOT NULL,
	"currency" text NOT NULL,
	"low_minor" integer NOT NULL,
	"high_minor" integer NOT NULL,
	"condition" text NOT NULL,
	"geography" text NOT NULL,
	"sample_size" integer NOT NULL,
	"confidence" real NOT NULL,
	"provenance" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_observations_lane_check" CHECK ("snap_to_post"."price_observations"."lane" in ('msrp_at_launch', 'current_new_retail', 'active_used_ask_distribution', 'verified_sold_comp_distribution', 'first_party_historical_ask_distribution', 'first_party_offer_distribution', 'first_party_counteroffer_distribution', 'first_party_agreed_price_distribution', 'first_party_historical_sale_distribution', 'recommended_list_price', 'expected_transaction_range', 'quick_sale_price')),
	CONSTRAINT "price_observations_currency_check" CHECK ("snap_to_post"."price_observations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "price_observations_low_minor_check" CHECK ("snap_to_post"."price_observations"."low_minor" >= 0),
	CONSTRAINT "price_observations_range_check" CHECK ("snap_to_post"."price_observations"."high_minor" >= "snap_to_post"."price_observations"."low_minor"),
	CONSTRAINT "price_observations_sample_size_check" CHECK ("snap_to_post"."price_observations"."sample_size" > 0),
	CONSTRAINT "price_observations_confidence_check" CHECK ("snap_to_post"."price_observations"."confidence" >= 0 and "snap_to_post"."price_observations"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."price_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snap_to_post"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK ("snap_to_post"."sessions"."status" in ('active', 'stopped', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "snap_to_post"."sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "snap_to_post"."claim_evidence_sources" ADD CONSTRAINT "claim_evidence_sources_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "snap_to_post"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."claim_evidence_sources" ADD CONSTRAINT "claim_evidence_sources_source_id_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "snap_to_post"."evidence_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."claims" ADD CONSTRAINT "claims_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."control_events" ADD CONSTRAINT "control_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "snap_to_post"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."control_events" ADD CONSTRAINT "control_events_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."control_events" ADD CONSTRAINT "control_events_track_id_item_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "snap_to_post"."item_tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."evidence_sources" ADD CONSTRAINT "evidence_sources_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."images" ADD CONSTRAINT "images_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."images" ADD CONSTRAINT "images_track_id_item_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "snap_to_post"."item_tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."item_intents" ADD CONSTRAINT "item_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "snap_to_post"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."item_tracks" ADD CONSTRAINT "item_tracks_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snap_to_post"."price_observations" ADD CONSTRAINT "price_observations_item_intent_id_item_intents_id_fk" FOREIGN KEY ("item_intent_id") REFERENCES "snap_to_post"."item_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claim_evidence_sources_claim_id_source_id_unique" ON "snap_to_post"."claim_evidence_sources" USING btree ("claim_id","evidence_source_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_sources_evidence_source_id_idx" ON "snap_to_post"."claim_evidence_sources" USING btree ("evidence_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_item_intent_id_path_revision_unique" ON "snap_to_post"."claims" USING btree ("item_intent_id","path","revision");--> statement-breakpoint
CREATE INDEX "claims_item_intent_id_status_idx" ON "snap_to_post"."claims" USING btree ("item_intent_id","status");--> statement-breakpoint
CREATE INDEX "control_events_session_id_received_at_idx" ON "snap_to_post"."control_events" USING btree ("session_id","received_at");--> statement-breakpoint
CREATE INDEX "control_events_item_intent_id_revision_idx" ON "snap_to_post"."control_events" USING btree ("item_intent_id","revision");--> statement-breakpoint
CREATE INDEX "control_events_track_id_idx" ON "snap_to_post"."control_events" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_sources_item_intent_id_source_id_unique" ON "snap_to_post"."evidence_sources" USING btree ("item_intent_id","source_id");--> statement-breakpoint
CREATE INDEX "evidence_sources_item_intent_id_observed_at_idx" ON "snap_to_post"."evidence_sources" USING btree ("item_intent_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "images_item_intent_id_sha256_unique" ON "snap_to_post"."images" USING btree ("item_intent_id","sha256");--> statement-breakpoint
CREATE INDEX "images_item_intent_id_captured_at_idx" ON "snap_to_post"."images" USING btree ("item_intent_id","captured_at");--> statement-breakpoint
CREATE INDEX "images_track_id_idx" ON "snap_to_post"."images" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_intents_session_id_sequence_unique" ON "snap_to_post"."item_intents" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "item_intents_session_id_status_idx" ON "snap_to_post"."item_intents" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "item_tracks_item_intent_id_started_at_idx" ON "snap_to_post"."item_tracks" USING btree ("item_intent_id","started_at");--> statement-breakpoint
CREATE INDEX "price_observations_item_intent_id_lane_observed_at_idx" ON "snap_to_post"."price_observations" USING btree ("item_intent_id","lane","observed_at");--> statement-breakpoint
CREATE INDEX "sessions_device_id_started_at_idx" ON "snap_to_post"."sessions" USING btree ("device_id","started_at");