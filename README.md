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

## Validation

```bash
pnpm typecheck
pnpm test
pnpm --filter @snap/mobile exec expo install --check
```
