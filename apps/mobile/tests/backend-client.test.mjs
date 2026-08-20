import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchBackendHealth,
  parseServerEvent,
  resolveBackendUrl,
  resolveControlSocketUrl,
} from '../src/features/backend/backend-client.ts';

test('normalizes the configured API and WebSocket URLs', () => {
  assert.equal(resolveBackendUrl('http://192.168.1.20:8787/'), 'http://192.168.1.20:8787');
  assert.equal(
    resolveControlSocketUrl('https://api.example.com/base'),
    'wss://api.example.com/v1/control',
  );
});

test('validates the backend health response', async () => {
  const health = await fetchBackendHealth({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl: async () =>
      Response.json({
        service: 'snap-api',
        status: 'ok',
        protocolVersion: 1,
      }),
  });

  assert.equal(health.status, 'ok');
});

test('accepts bounded server error events', () => {
  const event = parseServerEvent(
    JSON.stringify({
      type: 'control.error',
      eventId: 'server-event-1',
      sessionId: 'session-1',
      revision: 2,
      schemaVersion: 1,
      serverTimestamp: '2026-08-20T12:00:01.000Z',
      payload: {
        code: 'invalid_event',
        message: 'Invalid event',
      },
    }),
  );

  assert.equal(event.type, 'control.error');
});
