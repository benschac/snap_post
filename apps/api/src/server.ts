import type { ServerType } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDatabaseClient } from './database/client.ts';
import { createApiServer } from './runtime.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

const hostname = process.env.HOST ?? '0.0.0.0';
const port = readPort(process.env.PORT);
const databaseClient =
  process.env.DATABASE_URL === undefined ? undefined : createDatabaseClient();
let isShuttingDown = false;

const server = createApiServer({
  database: databaseClient?.db,
  hostname,
  port,
  onListening: ({ address, port: listeningPort }) => {
    console.info(`Snap API listening on http://${address}:${listeningPort}`);
  },
});

function shutdown(signal: NodeJS.Signals, activeServer: ServerType): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(`Received ${signal}; closing Snap API`);
  activeServer.close(async (error) => {
    if (error) {
      console.error('Snap API shutdown failed', error);
      process.exitCode = 1;
    }
    await databaseClient?.close();
  });
}

process.once('SIGINT', () => shutdown('SIGINT', server));
process.once('SIGTERM', () => shutdown('SIGTERM', server));
