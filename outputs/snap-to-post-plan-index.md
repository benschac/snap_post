# Snap to Post: complete plan index

Updated: 2026-08-20 (oRPC transport checkpoint; gating questions remain governed by the [decision log](./decision-log.md))

Status: implementation is underway. Slice B0's database/schema foundation, contract-first oRPC transport, and transactional event ingestion are complete locally; durable replay/reconnection, signed uploads, and physical end-to-end proof remain.

## What “the complete plan” means

The 433-line document is not the whole Snap plan. It is only the ML/AI learning companion.

The current complete planning set is:

| Document | Owns |
|---|---|
| [Product and technical brief](./snap-to-post-project-brief.md) | Product scope, UX, architecture, mobile/native implementation, backend, retrieval, data, models, latency, risk, and prototype sequence |
| [ML/AI 80/20 ramp-up](./snap-to-post-ml-80-20-ramp-up.md) | The concepts, curriculum, vocabulary, experiments, and ML judgment needed to lead the work |
| [Decision log](./decision-log.md) | Dated decisions that resolve or override the brief; when they conflict, the newest decision-log entry wins until the brief is updated |

This index is a map, not a third competing specification. When implementation details conflict, the product and technical brief is the source of truth. The learning guide explains how to reason about and evaluate the probabilistic parts of that plan.

## The entire plan in one view

### 1. Product objective

Build an iPhone-first React Native application that lets a user move rapidly through a storage unit, room, or house while the system:

1. observes the current object through the live camera;
2. automatically selects clean still images without requiring capture taps;
3. listens to the user's spoken description and condition notes;
4. identifies the item at the most specific defensible level;
5. retrieves canonical product information and current new-retail evidence;
6. optionally retrieves timestamped secondhand market observations;
7. creates a structured listing draft;
8. continues processing completed items in the background;
9. presents a fast end-of-session review rather than auto-publishing.

The app should not be the pacing bottleneck. The practical bottleneck should be the user's ability to move the camera and describe the next item.

### 2. First proof-of-concept boundaries

- Latest owned iPhone Pro only.
- English speech-to-text only.
- US market and USD.
- Strong network is acceptable.
- Cost is secondary to latency.
- Broad household and consumer goods rather than a narrow product category.
- No third-party marketplace publishing.
- No automatic posting.
- No text-to-speech.
- No formal end-to-end automated test program initially.
- No Android optimization initially.
- Multi-item stitch/sweep mode follows the single-item pipeline.

### 3. Session experience

The normal interface contains:

- Start/Stop;
- a persistent on-screen Next Item button;
- live camera preview;
- live partial and final transcript;
- automatic-capture animation and subtle haptic;
- progressive identity candidates;
- progressive evidence, retail price, and listing fields;
- completed-item/background-job state;
- a review queue with yes/no/edit decisions;
- optional developer/debug capture and timing controls.

Start begins microphone streaming immediately. Search can begin from spoken hints before the system has a stable object. Automatic capture happens when the frame is stable, sharp, sufficiently exposed, framed, and novel relative to retained views.

The Next Item button always advances, even when imagery is weak. The previous item continues through identification, enrichment, and drafting in the background. Stop ends new intake and transitions toward inventory review while accepted work completes.

### 4. Identity contract

Identity is hierarchical:

```text
category
  -> brand
  -> product family
  -> exact model/SKU
  -> variant
```

Snap returns only the most specific level supported by the evidence. Exact identity is preferred, but category-only or `unknown` is a valid result. Generic plates, tables, mugs, forks, pots, and similar goods must not receive invented manufacturers.

Evidence may include:

- barcode, GTIN, UPC, or EAN;
- model plate or printed model number;
- package text;
- OCR tokens;
- user-spoken brand/store/product hints;
- first-party similar items;
- manufacturer or retailer catalog candidates;
- image similarity;
- VLM interpretation;
- agreement among independent sources.

User speech is evidence, not automatically verified fact. External product identity and current price require source provenance.

### 5. Price contract

The primary price output is current new-retail price, not launch MSRP.

The product should distinguish:

- current manufacturer price;
- current reputable-retailer price;
- MSRP when separately known;
- active secondhand asking prices;
- verified sold prices when genuinely available;
- the recommended quick-sale price;
- the expected resale range.

Missing manufacturer or current-retail evidence lowers confidence but does not block an item from entering review. Asking price, listing disappearance, and a sold badge are not automatically treated as completed transaction price.

### 6. Client architecture

The React Native client uses:

- React Native VisionCamera for preview and frame access;
- frame processors/worklets for high-frequency native work;
- Skia and Reanimated for the live overlay;
- automatic frame-quality and novelty gating;
- barcode/OCR fast lanes;
- selected-still upload rather than continuous full-frame upload;
- live speech-to-text partials;
- streaming backend events;
- a local session state machine that binds images, speech, and results to the correct item.

High-frequency frame data does not cross into React state. React receives compact, throttled state such as boxes, scores, transcript text, candidates, and job status.

### 7. On-device model role

On-device inference performs cheap, latency-sensitive work:

- frame quality and capture gating;
- broad object/category routing when useful;
- barcode recognition;
- selected-frame OCR;
- image embeddings for novelty, deduplication, and retrieval;
- optional lightweight detection or segmentation if the prototype proves it necessary.

On-device classification does not establish exact identity by itself. Exact product identification remains a multimodal retrieval/evidence problem.

Use PyTorch for off-device experimentation, evaluation, fine-tuning, quantization, and export. Use ExecuTorch through `react-native-executorch` for deployed PyTorch models. Do not adopt legacy PyTorch Mobile or `react-native-pytorch-core`.

### 8. Native-code boundary

Use the highest-level implementation that satisfies the measured latency budget.

Write an Expo Swift module first for Apple-specific service orchestration where the call frequency is moderate:

- speech session lifecycle;
- audio-buffer streaming and partial/final transcript events;
- capture haptics;
- thermal/memory/performance reporting;
- native signposts and metrics;
- background/upload coordination where platform APIs require it.

Use VisionCamera frame processors and existing native plugins for hot camera paths.

Use a Nitro module only when a measured hot path requires frequent low-overhead calls or buffer ownership across JS/native boundaries, such as:

- zero/low-copy frame or tensor exchange;
- fused preprocessing;
- native streaming parsers;
- very high-frequency compact events;
- a custom native compute primitive not served by the existing stack.

C++, Objective-C++, Metal, or Rust are later tools for specific measured bottlenecks. They are not phase-zero requirements.

### 9. Backend architecture

The backend accepts independent streams of evidence:

- provisional item/session events;
- speech partials and finalized spans;
- selected images and capture metadata;
- barcode/OCR/model-plate tokens;
- user hints and condition notes.

It races independent work:

- exact-identifier lookup;
- first-party hybrid retrieval;
- fast VLM candidate generation;
- manufacturer and retailer discovery;
- canonical-page validation;
- current-retail retrieval;
- optional market-comparable retrieval;
- structured listing generation.

The frontend receives typed incremental events rather than waiting for one monolithic response. Raw candidates may arrive before slower source validation. Jobs have deadlines, cancellation, idempotency, and item/session identifiers so late results cannot attach to the wrong item.

### 10. Retrieval and memory

Begin with Postgres, full-text search, exact-token indexes, and pgvector or another benchmarkable local vector index. The initial 3,653 first-party items do not require a dedicated vector database for scale.

Retrieve through three complementary signals:

- exact identifiers and lexical tokens;
- image/text embedding similarity;
- structured metadata filters.

Fuse the signals and rerank a small candidate set. Keep the interface provider-neutral so Pinecone or another vector service can be benchmarked later if corpus size, latency, tenancy, or operational requirements justify it.

Maintain a canonical public-product cache so manufacturer pages, retailer pages, identifiers, and verified metadata found for one item can accelerate later users. Do not silently place private voice, condition, location, or user content into a global corpus.

### 11. External sources

Source priority is:

1. consented first-party records and corrections;
2. manufacturers, retailers, and identifier services such as GS1;
3. official marketplace APIs;
4. commercial datasets with explicit contractual downstream rights;
5. appropriately licensed research datasets;
6. source-reviewed browser collection as a last resort.

Firecrawl, Browserbase, Apify, or similar tools provide extraction infrastructure, not rights to collect or train on source content. Craigslist and Meta Marketplace collection cannot be assumed permissible merely because content is publicly visible.

Every external record should preserve source, canonical URL, source record ID, observation/retrieval time, license basis, retention class, content hash, and deletion state.

### 12. Model cascade

The system uses a cascade rather than one universal model:

```text
quality/novelty gate
  -> barcode and OCR
  -> on-device embedding/detection
  -> exact and semantic retrieval
  -> fast remote VLM candidate generation
  -> candidate reranker
  -> source/evidence validation
  -> calibrated identity level or abstention
  -> structured draft generation
```

Small models route and reduce work. Larger frontier or open-weight models handle ambiguity on selected evidence. Current facts remain in retrieval rather than model weights.

### 13. Voice

Speech-to-text runs from session start, producing visible partial and finalized English transcript. Spoken product hints can start retrieval before visual stability. Condition statements attach to the active item through explicit session/item timing rules.

Raw audio is ephemeral for the prototype unless a later approved experiment establishes a specific need. Final transcript, selected spans, user edits, and relevant telemetry may be retained under ordinary product controls.

Speech is descriptive only in the first prototype. Item boundaries and corrections use explicit controls.

### 14. Data and learning strategy

Use existing records first for:

1. schema and label-quality audit;
2. fixed evaluation examples;
3. first-party retrieval;
4. prompt/example selection;
5. small candidate reranking or calibration;
6. task-specific fine-tuning only after a measured baseline plateau.

Record future learning events:

- candidates shown;
- accepted/rejected identities;
- exact corrections;
- identity granularity;
- image selected/rejected;
- source accepted/rejected;
- transcript hints;
- field edits;
- latency and provider outcomes;
- listed and agreed prices;
- offer, cancellation, and fulfillment events.

Use immutable evaluation events plus a current item projection. Never use an unconfirmed model guess as ground truth.

### 15. RAG and post-training

Use hybrid retrieval/entity resolution for dynamic and attributable information:

- identity candidates;
- official URLs;
- catalog attributes;
- current retail;
- recent market observations;
- similar first-party items.

Use post-training only for demonstrated behavior gaps:

- contrastive image-embedding improvement;
- same-product versus wrong-variant separation;
- candidate reranking;
- confidence calibration;
- category/detector adaptation;
- structured listing style.

Do not pretrain a household foundation model. Do not fine-tune merely because data exists.

### 16. Evaluation corpus

Begin with 30–50 deliberately chosen items in three difficulty lanes:

- identifier-rich products;
- branded but visually ambiguous products;
- generic or visually unknowable goods.

Record category, brand, family, model, variant, knowability, evidence, capture conditions, and hard negatives. Grow toward 200–500 items after the first prototype exposes actual failure modes.

Prevent leakage across physical items, products/SKUs, and time. Include clutter, blur, damage, missing accessories, lighting differences, and model variants.

### 17. Quality metrics

Track:

- usable automatic-capture rate;
- duplicate/missed-item rate;
- category/brand/family/model/variant accuracy;
- candidate recall@k;
- exact-identity precision and coverage;
- false-exact rate;
- abstention quality;
- valid-source and current-retail evidence rate;
- review corrections and review time;
- transcript entity recall;
- post-ready completion rate;
- backlog remaining at Stop.

Accuracy must be reported by knowability and category/difficulty slice.

### 18. Performance metrics

Instrument the full critical path:

- frame arrival;
- quality/novelty computation;
- still selection and capture;
- preprocessing and tensor creation;
- local inference;
- image encode and upload;
- speech partial and final events;
- backend ingress;
- candidate generation;
- retrieval and reranking;
- external-source discovery and validation;
- first identity candidate;
- current-retail evidence;
- first listing field;
- post-ready state;
- UI commit.

Measure p50/p95/p99, not only averages. Separate cold/warm cache, model load/specialization/inference, network phases, and provider timing. Record memory, dropped frames, queue depth, cancellation, thermal state, and five-minute sustained behavior on the physical device.

### 19. Latency strategy

The latency plan is:

1. start voice and provisional search immediately;
2. avoid processing every camera frame;
3. run cheap quality/novelty signals before expensive inference;
4. capture and upload only selected stills;
5. use exact identifiers as the fastest high-confidence lane;
6. stream upload and backend results;
7. race independent providers;
8. validate slower evidence asynchronously;
9. cache canonical public products;
10. prewarm connections and models;
11. cancel obsolete or losing work;
12. keep previous items processing while the user advances;
13. profile before adding native complexity.

### 20. Current dependency direction

Core prototype direction:

- Expo development build;
- React Native VisionCamera v5;
- Skia;
- Reanimated/worklets;
- Nitro Modules runtime;
- React Native ExecuTorch;
- VisionCamera worklets/resizer/barcode integration;
- native permission and app configuration.

Nitro-native networking (fetch/WebSocket/text-decoder) is deferred: the packages have a verified peer-dependency conflict as of 2026-08-18 and are not needed before profiling. Standard fetch/WebSocket serve Slices 0–2.

TypeGPU, WebGPU, alpha React Native runtimes, and custom Nitro/C++ modules remain experiments until compatibility and performance are demonstrated.

The Expo 57 / React Native 0.86 / React Native ExecuTorch combination must pass a real native compatibility gate before architectural assumptions are treated as working code.

### 21. Prototype sequence

#### Slice 0: Native compatibility gate

Prove a physical-device (iPhone 17 Pro) development build as an ordered sub-gate ladder: prune the experiment packages, add the VisionCamera plugin packages and microphone permission, then climb build → preview → frame processor → Skia overlay → one ExecuTorch inference → mic capture → barcode/resizer → 10-minute soak. ExecuTorch has a pre-decided fallback: skip it and use heuristic frame-quality gates rather than downgrading Expo/RN. The Nitro networking packages are deferred (verified peer-dependency conflict).

#### Slice 1: Zero-tap capture loop

Build the Start, Stop, and Next Item controls, camera stability and quality scoring, automatic selected stills, haptics/animation, item boundaries, and developer instrumentation.

#### Slice B0: Backend skeleton (parallel with Slices 0–1)

Local Hono/Node gateway (pnpm, `tsx watch`, `@hono/node-server` v2 plus `ws`) on the Mac with the phone over LAN; pinned stable oRPC contract-first `control.publish` and streaming `control.subscribe` procedures around the shared Zod event envelopes; Drizzle ORM plus Postgres.js as the server-only typed query/transaction layer; prototype-owned sessions/item-intents/tracks/images/control-events/claims/price tables in an isolated `snap_to_post` schema on a local/dev Supabase copy (pg_dump restore when first-party retrieval data is needed, pgvector enabled); Supabase SQL migrations as the sole migration/deployment authority, including hand-written RLS/grants and Storage policy SQL; a private signed-upload path to Supabase Storage; one device→server→device echo; provider spend/concurrency caps. The established marketplace project is read-only reference data and never the B0 write target; do not use `drizzle-kit push` or a separate Drizzle migration ledger against shared/remote databases.

Progress checkpoint — 2026-08-20:

- [x] Create the local Hono/Node gateway and health route.
- [x] Define the runtime-validated client/server event envelopes with Zod in the shared protocol package.
- [x] Wrap those envelopes in pinned oRPC 1.15 `control.publish` and async `control.subscribe` contracts, wire the Node WebSocket handler and inferred Expo client, and prove typed ping/pong through an ephemeral API integration test.
- [x] Add a repeatable 500-publish loopback benchmark. The latest isolated run measured approximately 0.33 ms p95 versus the earlier raw JSON/Zod baseline of 0.184 ms; this is local framing evidence, not phone-over-LAN proof.
- [x] Add the server-only Postgres.js/Drizzle client and isolate the prototype tables in the `snap_to_post` PostgreSQL schema.
- [x] Define sessions, item intents, tracks, images, control-event idempotency records, claims/evidence, and price observations in Drizzle with constraints, indexes, inferred types, and RLS declarations.
- [x] Generate the reviewed base migration through Drizzle Kit and keep Supabase migrations as the sole deployment history; retain companion SQL for extensions, grants, default privileges, and the private Storage bucket.
- [x] Verify the schema statically and exercise a transaction against the configured integration database when `DATABASE_URL` is available.
- [x] Persist the initial seven domain events transactionally through an injected Drizzle dependency. Projection writes and the immutable `control_events` row commit together; item sequences are allocated under a session-row lock; identical retries return the original receipt; mismatched event-ID reuse is rejected; and oRPC acknowledges only after commit.
- [ ] Back `control.subscribe({ afterRevision })` with durable `control_events` replay and add the mobile connection/reconnect/background lifecycle. The current publisher is process-local and streams only future events.
- [ ] Add the narrowly scoped signed-upload endpoint and complete the selected-image upload receipt flow.
- [ ] Add provider request ceilings and concurrency caps before external identification providers are enabled.
- [ ] Prove one physical device → LAN server → database/upload → device round trip; the automated ping/pong test is not physical-device evidence.

#### Slice 2: Exact-identifier fast lane

Add barcode/model-plate/OCR capture, exact-token retrieval, identifier resolution, and progressive identity fields.

#### Slice 3: Visual-only identity race

Add embeddings, first-party image retrieval, fast VLM candidate generation, candidate streaming, reranking, and abstention.

#### Slice 4: Voice and condition

Add live STT, visible dictation, provisional voice-driven search, item binding, and structured condition notes.

#### Slice 5: Enrichment and valuation

Add canonical product evidence, current new-retail price, public-product caching, optional secondhand observations, and structured listing drafts.

#### Slice 6: Storage-unit session

Run a realistic mixed-item five-to-ten-minute session. Measure human throughput, missed/duplicate items, background backlog, review friction, latency, accuracy, memory, and thermal behavior.

### 22. Future stitch/sweep mode

After the single-item pipeline works:

- capture a wide image or sweep;
- detect/segment multiple objects;
- create one item crop/job per object;
- reuse the same ordinary identity/evidence/draft pipeline;
- run item jobs concurrently;
- reconcile duplicates and boundaries before review.

It is an adapter over the single-item system, not a separate architecture.

### 23. ML/AI ramp-up

The companion learning guide covers:

- problem framing and knowability;
- evaluation and leakage;
- data quality and active learning;
- embeddings, hybrid retrieval, and reranking;
- practical computer vision;
- on-device inference and quantization;
- LLM/VLM/RAG systems;
- experiment design and ML operations;
- sixteen common unknown unknowns;
- a focused 15–20-hour curriculum;
- six hands-on exercises;
- a vocabulary checkpoint;
- the decision tree for whether to improve capture, OCR, retrieval, ranking, calibration, evidence retrieval, generation, or systems performance.

### 24. Deliberately deferred work

- Android and broad device support;
- automatic third-party publishing;
- multi-item stitch/sweep until single-item flow works;
- a custom vector database or ANN implementation;
- a custom C++/Rust/Metal inference stack without profiling evidence;
- foundation-model pretraining;
- generic large-scale post-training;
- resale-price ML without genuine transaction outcomes;
- raw-audio retention;
- voice-command and voice-correction grammar;
- formal E2E automation before a playable prototype;
- cost optimization before the latency/quality frontier is understood.

## What exists versus what does not

### Exists now

- comprehensive product requirements;
- end-to-end architecture;
- UX/session state contract;
- client/backend streaming design;
- native implementation boundaries;
- model and retrieval strategy;
- external-data and legal-risk strategy;
- latency instrumentation and performance targets;
- prototype build sequence;
- evaluation/data roadmap;
- ML learning curriculum.

### Exists as of 2026-08-20

- the Expo application repository at this repo root (`app.json`, prebuilt `ios/`, `newArchEnabled: true`);
- a decision log resolving all implementation-gating questions: device (iPhone 17 Pro), backend (local Hono/Node over LAN), datastore (dev Supabase copy + pgvector + Supabase Storage), credentials (Groq + Exa only), package pruning and deferrals;
- the local Hono/Node API scaffold with health plus contract-first oRPC publish/subscribe over WebSockets;
- shared Zod client/server event envelopes, oRPC input/output contracts, and an inferred Expo control client;
- an API integration test for typed publish/subscribe and a repeatable local loopback latency benchmark;
- the Postgres.js/Drizzle database client, complete prototype schema, generated Supabase migration, companion Supabase configuration migration, and schema/integration tests.
- transactional ingestion for `session.started`, `item.intent_started`, `item.track_started`, `item.track_attached`, `image.selected`, `image.uploaded`, and `item.closed`, including atomic item sequencing and event-ID idempotency.

### Does not exist yet

- a successful Expo native build with the proposed dependency combination;
- a physical-device camera prototype;
- the 30–50-item labeled evaluation corpus;
- a model/retrieval benchmark harness;
- measured quality, latency, memory, network, or thermal results;
- durable subscription replay and the mobile reconnect/background connection manager;
- the signed-upload API and completed Supabase Storage upload-receipt flow;
- Groq/Exa credentials (self-serve, needed by Slices 2–3);
- an audited mapping from the existing marketplace schema into learning labels;
- production privacy, security, retention, or legal approvals;
- a trained custom model;
- evidence that a custom native module is necessary.

Those are implementation and evidence artifacts, not missing planning prose.

## Immediate next action

Planning should stop expanding until implementation produces new evidence.

### Completed milestone: B0 transactional event ingestion

1. Refactor [`apps/api/src/orpc.ts`](../apps/api/src/orpc.ts) into a router factory that accepts an injected Drizzle database dependency. Keep `control.ping` database-free so health/transport diagnostics remain available independently of persistence.
2. Add one persistence dispatcher for `session.started`, `item.intent_started`, `item.track_started`, `item.track_attached`, `image.selected`, `image.uploaded`, and `item.closed`. Use the client timestamp for the projection's occurrence time, allocate `item_intents.sequence` server-side while locking the owning session row, and map only identifiers that already have valid foreign-key targets.
3. In one Drizzle transaction, detect an existing `control_events.id`, materialize the relevant projection row or update, and insert the immutable event record. An identical retry returns the original successful receipt without a second mutation; reuse of an event ID with different content is rejected; a concurrent duplicate either wins once or rolls back completely.
4. Publish downstream server events only after commit. A failed transaction must produce no acknowledgement that implies persistence and no process-local subscriber event.
5. Add unit tests for every event-to-row mapping and database integration tests for the happy path, identical retry, mismatched event-ID reuse, concurrent duplicate, missing parent, and transaction rollback. The existing protocol/API/mobile typechecks and tests must remain green.

Acceptance for this milestone: a published supported domain event is acknowledged only after its projection and immutable ledger row commit together; replaying the same event is harmless; and tests can prove that no partial row survives a failed or racing transaction.

Completed locally on 2026-08-20. The focused database suite proves all seven projections, identical retry, concurrent duplicate serialization, atomic item sequence allocation, mismatched event-ID rejection, missing-parent rollback, projection-failure rollback, and oRPC receipt-after-commit readback against the isolated local Supabase schema.

### Next milestone: durable replay and mobile reconnection

Back `control.subscribe({ afterRevision })` with ordered durable replay from `control_events`, close the replay/live handoff race, and add the Expo connection manager for reconnect and foreground/background transitions. Keep session capture and Next Item transitions local and non-blocking.

Next, implement durable `afterRevision` replay plus the mobile reconnect/background lifecycle, then add the narrowly scoped signed-upload endpoint and complete the selected-image upload receipt flow. The next B0 proof gate is one physical device → LAN server → database/upload → device round trip. Provider request ceilings and concurrency caps must land before Slices 2–3 enable external providers. Slice 1's zero-tap capture work can continue in parallel, but neither automated tests nor a Simulator-only run count as physical-device proof. The 30–50-item evaluation manifest follows once the capture loop exists.
