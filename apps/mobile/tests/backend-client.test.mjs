import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createControlClient,
  fetchBackendHealth,
  identifyItemImages,
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

test('uploads multiple JPEG views and validates the identity response', async () => {
  const streamedEvents = [];
  const result = await identifyItemImages({
    baseUrl: 'http://127.0.0.1:8787',
    sessionId: 'session-1',
    itemIntentId: 'item-1',
    imageId: 'image-1',
    images: [
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' }),
    ],
    onEvent: (event) => streamedEvents.push(event.type),
    fetchImpl: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:8787/v1/identify');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['X-Snap-Session-Id'], 'session-1');
      assert.ok(init.body instanceof FormData);
      const images = init.body.getAll('images');
      assert.equal(images.length, 2);
      assert.deepEqual(images.map((image) => image.size), [3, 2]);
      const encoder = new TextEncoder();
      const chunks = [
        '{"type":"accepted","acceptedAt":"2026-08-20T12:00:00.000Z","request":',
        '{"sessionId":"session-1","itemIntentId":"item-1","imageId":"image-1"}}\n',
        `${JSON.stringify({
          type: 'result',
          response: {
            requestId: 'request-1',
            sessionId: 'session-1',
            itemIntentId: 'item-1',
            imageId: 'image-1',
            provider: {
              name: 'ai-gateway',
              model: 'google/gemini-3.7-flash',
              latencyMs: 240,
            },
            candidate: {
              candidateId: 'candidate-1',
              level: 'product_family',
              category: 'e-reader',
              brand: 'Amazon',
              productName: 'Kindle',
              confidence: 0.84,
              provenance: [{ sourceId: 'request-1', sourceType: 'provider' }],
            },
            signals: {
              visibleText: ['kindle'],
              searchQuery: 'Amazon Kindle e-reader',
            },
          },
        })}\n`,
      ];
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    },
  });

  assert.deepEqual(streamedEvents, ['accepted', 'result']);
  assert.equal(result.response.candidate.productName, 'Kindle');
  assert.equal(result.metrics.imageBytes, 5);
  assert.equal(result.metrics.imageCount, 2);
  assert.ok(result.metrics.firstEventMs >= 0);
  assert.equal(result.metrics.providerLatencyMs, 240);
  assert.equal(result.metrics.roundTripOverheadMs, 0);
  assert.ok(result.metrics.endToEndMs >= 0);
});
