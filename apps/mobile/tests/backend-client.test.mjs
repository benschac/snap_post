import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createControlClient,
  fetchBackendHealth,
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

test('creates a typed oRPC client around the provided control socket', () => {
  const client = createControlClient({
    readyState: 0,
    addEventListener() {},
    removeEventListener() {},
    send() {},
  });

  assert.equal(typeof client.control.publish, 'function');
  assert.equal(typeof client.control.subscribe, 'function');
});
