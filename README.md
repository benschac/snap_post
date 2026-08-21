# Snap to Post

Snap to Post is a pnpm/Turborepo workspace with an Expo mobile client and a dedicated Hono backend.

## Workspace

```text
apps/mobile       Expo and React Native application
apps/api          Hono Node control plane
packages/protocol Shared HTTP and WebSocket contracts
outputs           Product and technical plans
```

Install dependencies from the repository root:

```bash
pnpm install
```

Run both development processes:

```bash
pnpm dev
```

Run only the Expo development server from the repository root:

```bash
pnpm start
```

Always use the root scripts or run Expo inside `apps/mobile`. Running `npx expo start` at the repository root treats the workspace root as an Expo project and cannot resolve the mobile entrypoint.

Run one application when you do not need the whole workspace:

```bash
pnpm --filter @snap/mobile start
pnpm --filter @snap/api dev
```

The existing root shortcuts still work through Turbo: `pnpm ios`, `pnpm ios:dev-client`, `pnpm android`, and `pnpm web`.

The API listens on `0.0.0.0:8787` by default so a physical phone can connect over the local network. Copy the package-local examples before development and replace the placeholder LAN address:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/mobile/.env.example apps/mobile/.env
```

No server secret belongs in the mobile environment. Variables prefixed with `EXPO_PUBLIC_` are bundled into the application.

## Database

The Hono API uses Drizzle ORM with Postgres.js against a local or isolated development Supabase database. The existing marketplace project is reference-only and must not receive Snap to Post writes.

Start the local stack and apply any pending migrations without deleting local data:

```bash
pnpm db:start
pnpm --filter @snap/api db:migrate:local
```

For a clean first-time setup, or to prove the complete migration history replays before merging, reset the local database:

```bash
pnpm --filter @snap/api db:reset:local
```

This command deletes local database data, applies every migration in order, and then runs configured seeds. Seeding is currently disabled in `supabase/config.toml`.

### Structural migration workflow

When the relational schema changes:

```bash
# 1. Edit apps/api/src/database/schema.ts.

# 2. Generate the next SQL migration and Drizzle snapshot.
pnpm --filter @snap/api db:generate --name=describe_the_change

# 3. Review both the generated SQL and snapshot metadata.
git diff -- supabase/migrations

# 4. Validate Drizzle's migration journal.
pnpm --filter @snap/api db:check

# 5. Apply only pending migrations while preserving local data.
pnpm --filter @snap/api db:migrate:local

# 6. Before merging, prove a clean replay from scratch.
pnpm --filter @snap/api db:reset:local

# 7. Run the database and API tests.
pnpm --filter @snap/api test
```

Commit the schema change, generated SQL migration, and generated `supabase/migrations/meta` updates together. Use `supabase migration new <name>` for a companion migration that configures Supabase-only features that Drizzle does not model.

Prototype tables live in the private `snap_to_post` PostgreSQL schema. Drizzle is the source of truth for schemas, tables, columns, constraints, indexes, and RLS declarations; its committed snapshot metadata generates subsequent diffs. Small companion migrations own Supabase-specific extensions, grants/default privileges, Storage configuration, and unsupported PostgreSQL features.

Supabase migrations under `supabase/migrations` are the only deployment history. Apply them only with the Supabase CLI; do not use `drizzle-kit push`, `drizzle-kit migrate`, or Drizzle's runtime migrator against local, shared, or remote databases. `pnpm db:schema:sql` remains a stateless review of the complete TypeScript model.

### Viewing local tables

In this local stack, Supabase Studio's Table Editor only lists schemas configured for the Data API. Snap to Post intentionally has no application tables in `public`, and the private `snap_to_post` schema is intentionally absent from the Data API schema list in `supabase/config.toml`. An empty `public` Table Editor therefore does not mean migrations are missing.

Inspect the private tables through Studio's SQL Editor or the CLI instead:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'snap_to_post'
order by table_name;
```

The Hono API accesses `snap_to_post` directly through the server-only `DATABASE_URL`; it is not exposed to the mobile client through Supabase REST. Do not add the schema to `api.schemas` only to make it appear in the Table Editor, because that also broadens the Data API surface.

Set `DATABASE_URL` only in `apps/api/.env`. The default local Supabase connection is shown in the example file; the mobile app never receives a database URL or service-role key.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm --filter @snap/mobile exec expo install --check
```
