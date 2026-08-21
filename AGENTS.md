# Snap to Post working agreement

## Execution

- Work autonomously through clear, reversible, in-scope tasks. Ask only for destructive, irreversible, credential-gated, production-writing, materially branching, or truly ambiguous actions.
- Preserve user changes and keep diffs small. Dirty worktrees are normal; do not alter unrelated work or add dependencies without authorization.
- Ground conclusions in the owning code, schema, durable row, first-fatal log, deployment artifact, or current official documentation.
- Start production and account investigations read-only. Do not perform external writes or destructive SQL unless explicitly requested.
- Use native subagents only for bounded independent work that materially improves speed, quality, or safety. The leader owns integration and verification.
- For cleanup/refactoring, state the cleanup plan and protect untested behavior before editing.
- Verify with the smallest relevant test, typecheck, lint, build, or static check. Read the result before claiming completion.
- Final reports state the outcome, changed files, validation evidence, and any remaining risk.

## Repository

- This is a pnpm 11 / Turborepo workspace. Run commands from the repository root unless a package-local command is explicitly required.
- `apps/mobile` owns the Expo/React Native application.
- `apps/api` owns the Hono/Node control plane and database access.
- `packages/protocol` owns runtime-neutral HTTP and WebSocket contracts shared by mobile and API.
- `outputs` contains product plans, decision records, and validation handoffs; it is evidence, not automatically current runtime truth.
- Use root scripts such as `pnpm start`, `pnpm dev`, `pnpm ios`, `pnpm typecheck`, and `pnpm test`. Do not run `npx expo start` from the repository root.

## Expo and native work

- The mobile baseline is Expo SDK 57, React Native 0.86, and VisionCamera 5. Inspect `apps/mobile/package.json` and the [Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) before changing native dependencies or configuration.
- Treat dependency installation, JavaScript export, native compilation, Simulator behavior, and physical-device behavior as separate proof boundaries.
- For iOS build failures, inspect the earliest fatal diagnostic in `.expo/xcodebuild.log`; do not diagnose from the final exit code alone.
- Do not claim camera, microphone, thermal, performance, signing, LAN connectivity, or native-module behavior from static checks or Simulator-only evidence.
- Keep camera initialization lazy. Keep the mounted camera session stable and use `isActive` for lifecycle changes when supported by the owning code.
- Every VisionCamera/GPU frame must be disposed on every path. Bound asynchronous analysis, allow at most one pending analysis task unless the implementation proves another limit safe, and drop work when busy instead of building an unbounded queue.
- Keep high-frequency frame data out of React state. Measure frame rate, queue depth, memory, and thermals on the physical target device before making performance claims.
- Apple `SpeechAnalyzer` is the first on-device speech lane for the current iPhone-first target. Persist final results; treat volatile partial results as transient UI state.
- Do not add a second custom camera session, native module, GPU conversion path, or cloud provider until measured evidence shows the existing boundary is insufficient.

## API, data, and secrets

- The mobile app talks to the Hono API; it must not receive `DATABASE_URL`, service-role keys, or other server secrets. `EXPO_PUBLIC_*` values are bundled into the app.
- Snap to Post writes only to local or isolated development data unless production access and mutation are explicitly authorized. The existing marketplace project is reference-only.
- Drizzle schema lives in `apps/api/src/database/schema.ts`. Commit schema changes, generated SQL migrations, and `supabase/migrations/meta` updates together.
- Supabase migrations under `supabase/migrations` are the only deployment history. Do not use `drizzle-kit push`, `drizzle-kit migrate`, or Drizzle's runtime migrator against local, shared, or remote databases.
- Prefer `pnpm --filter @snap/api db:migrate:local` for pending local migrations. `db:reset:local` is destructive to local data and must be used only when its reset semantics are intended.
- Keep the private `snap_to_post` schema out of the Data API unless the product boundary explicitly changes; an empty `public` Table Editor is not evidence that migrations are missing.

## Validation

- Start with the narrowest test covering the changed behavior, then expand in proportion to risk.
- Workspace gates are `pnpm typecheck`, `pnpm test`, and `pnpm lint` when relevant.
- For Expo dependency changes, also run `pnpm --filter @snap/mobile exec expo install --check`.
- For database changes, run `pnpm --filter @snap/api db:check`, apply pending local migrations, and run API tests. Use a clean reset only when replay-from-zero proof is required and local data loss is acceptable.
- State validation gaps explicitly. A successful compile is not physical-device proof, and a local result is not deployed or production proof.
