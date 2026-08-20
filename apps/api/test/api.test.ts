import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  CONTROL_PROTOCOL_VERSION,
  HealthResponseSchema,
  ServerControlEventSchema,
} from '@snap/protocol';
import { WebSocket } from 'ws';

import { createApiServer } from '../src/runtime.ts';

test('serves health and echoes a typed WebSocket control event', async (t) => {
  const server = createApiServer({ hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');

  t.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });

  const { port } = server.address() as AddressInfo;
  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(
    HealthResponseSchema.parse(await healthResponse.json()),
    {
      service: 'snap-api',
      status: 'ok',
      protocolVersion: CONTROL_PROTOCOL_VERSION,
    },
  );

  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/control`);
  await once(socket, 'open');

  socket.send(
    JSON.stringify({
      type: 'control.ping',
      eventId: 'event-1',
      sessionId: 'session-1',
      revision: 0,
      schemaVersion: CONTROL_PROTOCOL_VERSION,
      clientTimestamp: '2026-08-20T12:00:00.000Z',
      payload: { nonce: 'nonce-1' },
    }),
  );

  const [message] = await once(socket, 'message');
  const response = ServerControlEventSchema.parse(
    JSON.parse(message.toString()),
  );

  assert.equal(response.type, 'control.pong');
  assert.equal(response.sessionId, 'session-1');
  assert.equal(response.payload.nonce, 'nonce-1');

  socket.close();
  await once(socket, 'close');
});
