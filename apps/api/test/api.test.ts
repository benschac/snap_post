import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  type ControlContractClient,
  CONTROL_PROTOCOL_VERSION,
  HealthResponseSchema,
} from '@snap/protocol';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
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

  const client: ControlContractClient = createORPCClient(
    new RPCLink({ websocket: socket }),
  );
  const events = await client.control.subscribe({ sessionId: 'session-1' });
  const nextEvent = events.next();
  const receipt = await client.control.publish({
    type: 'control.ping',
    eventId: 'event-1',
    sessionId: 'session-1',
    revision: 0,
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    clientTimestamp: '2026-08-20T12:00:00.000Z',
    payload: { nonce: 'nonce-1' },
  });
  const response = await nextEvent;

  assert.equal(receipt.eventId, 'event-1');
  assert.equal(response.done, false);
  assert.equal(response.value.type, 'control.pong');
  assert.equal(response.value.sessionId, 'session-1');
  assert.equal(response.value.payload.nonce, 'nonce-1');

  await events.return(undefined);
  socket.close();
  await once(socket, 'close');
});
