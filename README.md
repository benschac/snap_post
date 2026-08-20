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

Run one application when you do not need the whole workspace:

```bash
pnpm --filter @snap/mobile dev
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

Start the local stack and apply the existing migrations:

```bash
pnpm db:start
pnpm db:reset
```

When the relational schema changes, edit `apps/api/src/database/schema.ts`, generate a Supabase-formatted migration, review it, and replay the local database:

```bash
pnpm db:generate --name describe_the_change
pnpm db:reset
pnpm db:schema:sql
```

Prototype tables live in the private `snap_to_post` PostgreSQL schema. Drizzle is the source of truth for schemas, tables, columns, constraints, indexes, and RLS declarations; its committed snapshot metadata generates subsequent diffs. Small companion migrations own Supabase-specific extensions, grants/default privileges, Storage configuration, and unsupported PostgreSQL features.

Supabase migrations under `supabase/migrations` are the only deployment history. Apply them only with the Supabase CLI; do not use `drizzle-kit push`, `drizzle-kit migrate`, or Drizzle's runtime migrator against local, shared, or remote databases. `pnpm db:schema:sql` remains a stateless review of the complete TypeScript model.

Set `DATABASE_URL` only in `apps/api/.env`. The default local Supabase connection is shown in the example file; the mobile app never receives a database URL or service-role key.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm --filter @snap/mobile exec expo install --check
```
