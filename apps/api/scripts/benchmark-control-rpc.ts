import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import {
  type ControlContractClient,
  CONTROL_PROTOCOL_VERSION,
} from '@snap/protocol';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

import { createApiServer } from '../src/runtime.ts';

const RUNS = 500;
const WARMUP_RUNS = 25;

function percentile(values: number[], fraction: number): number {
  const index = Math.min(
    values.length - 1,
    Math.floor(values.length * fraction),
  );
  return values[index] ?? 0;
}

async function main(): Promise<void> {
  const server = createApiServer({ hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/control`);
  await once(socket, 'open');

  try {
    const client: ControlContractClient = createORPCClient(
      new RPCLink({ websocket: socket }),
    );
    const durations: number[] = [];

    for (let index = 0; index < RUNS + WARMUP_RUNS; index += 1) {
      const startedAt = performance.now();

      await client.control.publish({
        type: 'control.ping',
        eventId: `benchmark-${index}`,
        sessionId: 'benchmark-session',
        revision: index,
        schemaVersion: CONTROL_PROTOCOL_VERSION,
        clientTimestamp: new Date().toISOString(),
        payload: { nonce: `nonce-${index}` },
      });

      if (index >= WARMUP_RUNS) {
        durations.push(performance.now() - startedAt);
      }
    }

    durations.sort((left, right) => left - right);
    const average =
      durations.reduce((sum, value) => sum + value, 0) / durations.length;

    console.info(
      JSON.stringify({
        transport: 'orpc-websocket-zod',
        runs: RUNS,
        averageMs: average,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
      }),
    );
  } finally {
    socket.close();
    await once(socket, 'close');
    server.close();
    await once(server, 'close');
  }
}

void main();
