# Snap to Post: decision log

One dated entry per decision. Newest first. When a decision here conflicts with the brief, this log wins until the brief is updated.

## 2026-08-20 — Backend monorepo scaffold

### D21. oRPC owns typed control transport framing
Use pinned stable oRPC 1.15 contract-first procedures over the existing Node `ws` connection for client event publication and server event subscriptions. The shared Zod event envelopes remain the runtime-validated domain contract and retain `event_id`, revision, schema version, and session/item identifiers; oRPC owns only the outer procedure, correlation, acknowledgement, and stream framing. Hono continues to own ordinary HTTP routes such as `/health`, Drizzle remains server-only, and selected image bytes still upload directly to Supabase Storage. Capture and Next Item transitions must remain local and never await an RPC acknowledgement. An isolated 500-call loopback comparison measured raw JSON/Zod p95 at 0.184 ms and oRPC/Zod p95 at 0.331 ms on 2026-08-20; this is local evidence only, and physical iPhone-over-LAN publish/stream latency plus reconnect/background recovery remain required gates. Do not adopt the oRPC v2 beta until it is intentionally evaluated after a stable release.

### D15. Dedicated backend, shared repository
The repository is now a pnpm/Turborepo workspace: the existing Expo app lives in `apps/mobile`, the independently runnable Hono service lives in `apps/api`, and runtime-neutral HTTP/WebSocket contracts live in `packages/protocol`. The backend remains a separate Node process and future deployment even though client and server share one Git repository.

### D16. Use the maintained Hono Node WebSocket adapter
`@hono/node-ws` is deprecated. The control plane uses `@hono/node-server` v2's built-in `upgradeWebSocket` with a directly declared `ws` runtime dependency. The first scaffold exposes `GET /health` and a versioned `control.ping` → `control.pong` WebSocket round trip. Authentication, durable jobs, database tables, and signed uploads remain later B0 work.

### D17. Scaffold verification boundary
Workspace typechecks and tests pass, including a real ephemeral Node HTTP/WebSocket integration test and all pre-existing mobile capture tests. Expo config and the iOS Metro export resolve from `apps/mobile`. A physical phone-to-Mac LAN round trip remains unverified. Expo's dependency check also reports pre-existing patch-version drift within SDK 57, and the existing `react-native-executorch` package blocks Expo's web export because its published web bundle requires a missing internal `lib/package.json`.

## 2026-08-18 — Slice 0 implementation checkpoint (physical gates blocked)

### D14. Buildable harness is not a passed physical-device gate
The ordered Slice 0 ladder is implemented in the app: in-memory photo capture, a backpressured async frame worklet with explicit disposal on every handled/rejected/error path, a Skia overlay, library-hosted EfficientNet initialization/inference, native 16 kHz mono PCM capture, GPU resize, barcode scanning, signposts, thermal/resident-memory telemetry, a 10-minute timer, and JSON trace export.

Local proof passed:
- `pnpm exec expo install --check`
- `pnpm exec tsc --noEmit`
- iOS Hermes export through Metro (2,169 modules)
- CocoaPods installation, including `SnapNative` and all three VisionCamera 5.2.2 plugins
- unsigned generic arm64 iOS build with Xcode
- `git diff --check`

Physical proof is blocked at the first gate. The connected iPhone 17 Pro is paired, wired, booted, and has Developer Mode enabled, but Xcode reports no account for the available Apple Development team and no provisioning profile for `com.benschac.snap-to-post-ai`. No app was installed or launched, so preview, frame-processing/disposal behavior, overlay rendering, inference, PCM capture, barcode/resizer operation, and the 10-minute soak are **not yet marked passed**.

Candidate compile matrix (to be promoted to the working matrix only after the device ladder passes):
- iPhone 17 Pro; iOS 26.6 (`23G71`); Xcode 26.6 (`17F113`)
- Expo 57.0.14; React Native 0.86.2; Expo Dev Client 57.0.13
- VisionCamera 5.2.2; VisionCamera Worklets/Resizer/Barcode Scanner 5.2.2; React Native Worklets 0.10.1
- Nitro Modules 0.36.5; Nitro Image 0.15.1; Skia 2.6.2
- React Native ExecuTorch 0.9.3; Expo Resource Fetcher 0.9.1
- local `SnapNative` module 1.0.0

Resume condition: select an Apple Developer team/account that can sign the current bundle ID (or explicitly choose a replacement bundle ID), then build/install on the connected device and run the gates in D6 order through trace export after the soak.

## 2026-08-18 — Plan-review resolutions (pre-implementation)

### D1. Repository
The Expo app already exists at the repo root (`app.json`, prebuilt `ios/`, `src/`, `newArchEnabled: true`). Slice 0 works in place — no scaffolding.

### D2. Benchmark device
iPhone 17 Pro. This means iOS 26-class OS: Apple `SpeechAnalyzer` is available, so the first STT lane is **on-device Apple speech with no API key**. Cloud STT providers (Deepgram/ElevenLabs/OpenAI) are benchmarked later only if Apple quality or latency disappoints.

### D3. Backend: local-first Hono on Node (pnpm), not Vercel
The control plane needs a persistent WebSocket; Vercel serverless is the wrong shape for it. For the PoC the backend is a single Hono process on Node — managed with pnpm like the rest of the repo, run with `tsx watch`, with WebSockets supplied by the maintained `@hono/node-server` v2 adapter plus `ws` — **running on the Mac**, with the phone connecting over LAN IP. Zero deploys, hot reload, no cold starts — maximum iteration speed and the lowest possible latency. When it must leave the LAN, deploy the same process to Fly.io (single US-East region); that is a later step, not part of the first build.

### D4. Datastore: Supabase (data already lives there)
First-party items/images are in a Supabase Postgres. Path of least resistance:
- **Do not** point the prototype at the live marketplace project. Take a `pg_dump` and restore into a fresh dev Supabase project or local Postgres — prototype writes must never touch live data.
- Enable `pgvector` on the dev copy; add prototype-owned tables (sessions, items, images, claims, embeddings) alongside the restored data.
- Embedding job for ~3.6k items / ~9k images is a one-off script, not infrastructure.
- Object storage: Supabase Storage (already available, no new vendor).

### D5. Minimal credential set
Only two new keys for the whole couple-of-days scope, both instant self-serve: **Groq** (fast VLM + Whisper fallback) and **Exa** (web discovery). Skipped for PoC: eBay, GS1, Keepa, Deepgram/ElevenLabs, Perplexity, Firecrawl/Browserbase. Add only when a slice measurably needs them.

### D6. Slice 0 is an ordered sub-gate ladder, not one gate
1. Prune experiment-lane packages from `package.json` before the first build: `@react-native-runtimes/*`, `typegpu`, `@typegpu/react`, `react-native-webgpu`, `unplugin-typegpu`. They are declared experiments in the brief and only add native build failure surface. Re-add individually later.
2. Add `NSMicrophoneUsageDescription` (currently missing from `app.json`) next to the existing camera permission.
3. Add `react-native-vision-camera-worklets`, `-resizer`, `-barcode-scanner` (all exist at 5.2.2, aligned with VisionCamera 5.2.2).
4. **Defer** `react-native-nitro-fetch` / `-websockets` / `-text-decoder`: known peer-dep conflict today (`nitro-text-decoder@0.2.0` pins `nitro-modules@^0.35.2`; `nitro-fetch@1.6.1` needs `^0.36.1`). Not needed for Slices 0–1; standard fetch/WebSocket are fine until profiling says otherwise.
5. Gate order on device: bare build → VisionCamera preview + photo → worklets frame processor with disposal verified → Skia overlay → ExecuTorch init + one inference using a library-hosted model (no custom .pte export) → mic capture → barcode/resizer → 10-minute soak.
6. When the gate passes, record the exact working version matrix (Xcode, iOS, Expo, RN, every native package) in this log.

### D7. ExecuTorch fallback rule (pre-decided)
If ExecuTorch 0.9.3 fails on RN 0.86 (its compat table stops at 0.85): **proceed without it**. Slice 1's capture gate uses heuristic signals (Laplacian blur, exposure histogram, frame differencing) in worklets — no neural net required. Revisit ExecuTorch at Slice 3 (embeddings). Do not downgrade Expo/RN to chase it.

### D8. Backend skeleton is its own slice (B0)
Before Slice 2: Hono gateway, WebSocket event schema (typed payloads for the events named in the brief), Postgres tables for sessions/items/images/claims/price observations, signed-upload path to Supabase Storage, one device→server→device echo round-trip. Buildable in parallel with Slices 0–1.

### D9. Review UI is punted
Explicitly deferred until after Slice 5. Slice 6's "review friction" measurement moves to whenever the review screen exists. Capture → identify → enrich is the spine to prove first.

### D10. End-of-day target (today)
"Working" = Slice 0 gates 1–5 passing on the physical iPhone 17 Pro: dev build, live camera preview, frame processor running with a frame counter, Skia overlay drawing, and ideally one ExecuTorch inference. Auto-capture (Slice 1) starts tomorrow with heuristic gates.

### D11. Provider spend safety (not optimization)
Before any fan-out slice: per-session request ceiling and a hard per-provider concurrency cap in the orchestrator config. A runaway loop against paid APIs must fail closed.

### D12. STT benchmark corpus
Record 10–20 minutes of representative narration (echoey room, brand/model/store names, and condition observations) with Voice Memos before Slice 4, so all providers are judged on identical audio.

### D13. Next Item is button-only in the prototype
The first prototype has no spoken command grammar. **Next Item is an explicit on-screen button**, and all microphone input is treated as description or evidence for the active item. This removes command classification, false-positive item boundaries, and command-latency work from Slice 4. Voice-driven item advance can be reconsidered only after the button-based capture flow is measured.

## Open items (not blocking Slice 0)
- Speech↔item binding rules: define which item owns speech that spans a button-triggered Next Item boundary or finalizes after the camera has moved on.
- Listing-draft field schema: enumerate target fields before Slice 5.
- Slice 2–5 numeric acceptance criteria: bind existing metrics to slices as each begins.
- Slice 6 environment: verify signal strength at the test location, or accept confounded network numbers knowingly.
