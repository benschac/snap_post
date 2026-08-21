import assert from 'node:assert/strict';
import test from 'node:test';

import { IdentifyStreamEventSchema } from '@snap/protocol';

import { createApiApp } from '../src/app.ts';
import type { VisualIdentityResult } from '../src/providers/visual-identity.ts';
import { ProviderRequestBudget } from '../src/providers/provider-budget.ts';
import { ServerEventBroker } from '../src/server-events.ts';

const requestHeaders = {
  'content-type': 'image/jpeg',
  'x-snap-image-id': 'image-1',
  'x-snap-item-intent-id': 'item-1',
  'x-snap-session-id': 'session-1',
};

async function readIdentifyStream(response: Response) {
  const lines = (await response.text()).trim().split('\n');
  return lines.map((line) => IdentifyStreamEventSchema.parse(JSON.parse(line)));
}

test('returns a typed identity candidate for a selected preview', async () => {
  const logEvents: string[] = [];
  const serverEvents = new ServerEventBroker();
  const events = serverEvents.subscribe('session-1');
  const identityEventPromise = events.next();
  const app = createApiApp({
    logger: (_level, event) => logEvents.push(event),
    serverEvents,
    identifyImage: async ({ images }) => {
      assert.equal(images[0]?.contentType, 'image/jpeg');
      assert.deepEqual([...(images[0]?.imageBytes ?? [])], [1, 2, 3]);
      return {
        requestId: 'gateway-request-1',
        model: 'google/gemini-3.7-flash',
        latencyMs: 250,
        inference: {
          level: 'product_family',
          category: 'e-reader',
          brand: 'Amazon',
          productName: 'Kindle',
          model: null,
          variant: null,
          confidence: 0.84,
          visibleText: ['kindle'],
          searchQuery: 'Amazon Kindle e-reader',
        },
      };
    },
    searchEvidence: async (query) => {
      assert.equal(query, 'Amazon Kindle e-reader');
      return {
        requestId: 'exa-request-1',
        latencyMs: 175,
        results: [
          {
            id: 'result-1',
            title: 'Amazon Kindle',
            url: 'https://www.amazon.com/kindle',
            highlights: ['Kindle product page'],
          },
        ],
      };
    },
  });

  const response = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: requestHeaders,
    body: new Uint8Array([1, 2, 3]),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  const streamEvents = await readIdentifyStream(response);
  assert.equal(streamEvents[0]?.type, 'accepted');
  assert.equal(streamEvents[1]?.type, 'result');
  const resultEvent = streamEvents[1];
  if (resultEvent?.type !== 'result') assert.fail('Expected an identity result');
  assert.equal(resultEvent.response.candidate.productName, 'Kindle');
  assert.equal(resultEvent.response.provider.latencyMs, 250);

  const identityEvent = await identityEventPromise;
  assert.equal(identityEvent.value?.type, 'identity.candidate');
  if (identityEvent.value?.type !== 'identity.candidate') {
    assert.fail('Expected an identity candidate event');
  }
  assert.equal(identityEvent.value.payload.productName, 'Kindle');

  const evidenceEvent = await events.next();
  assert.equal(evidenceEvent.value?.type, 'evidence.patch');
  if (evidenceEvent.value?.type !== 'evidence.patch') {
    assert.fail('Expected an evidence patch event');
  }
  assert.equal(evidenceEvent.value.payload.provider?.name, 'exa');
  assert.equal(evidenceEvent.value.payload.provider?.latencyMs, 175);
  assert.equal(evidenceEvent.value.revision, identityEvent.value.revision + 1);
  assert.deepEqual(logEvents, [
    'identify.request_received',
    'identify.request_accepted',
    'identity_provider.request_started',
    'identity_provider.request_completed',
    'identity.event_published',
    'identify.result_streamed',
    'exa.request_scheduled',
    'exa.request_started',
    'exa.request_completed',
    'evidence.event_published',
  ]);

  await events.return(undefined);
});

test('publishes a partial identity candidate before the final provider result', async () => {
  const serverEvents = new ServerEventBroker();
  const events = serverEvents.subscribe('session-1');
  const app = createApiApp({
    serverEvents,
    identifyImage: async (_input, options) => {
      options?.onPartialInference?.({
        level: 'brand_category',
        category: 'e-reader',
        brand: 'Amazon',
        productName: null,
        model: null,
        variant: null,
        confidence: 0.72,
        visibleText: [],
        searchQuery: null,
      });
      return {
        requestId: 'gateway-request-streamed',
        model: 'google/gemini-3.7-flash',
        latencyMs: 220,
        inference: {
          level: 'product_family',
          category: 'e-reader',
          brand: 'Amazon',
          productName: 'Kindle',
          model: null,
          variant: null,
          confidence: 0.84,
          visibleText: ['kindle'],
          searchQuery: null,
        },
      };
    },
  });

  const response = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: requestHeaders,
    body: new Uint8Array([1]),
  });
  assert.equal(response.status, 200);
  await response.text();

  const partial = await events.next();
  const final = await events.next();
  assert.equal(partial.value?.type, 'identity.candidate');
  assert.equal(final.value?.type, 'identity.candidate');
  if (
    partial.value?.type !== 'identity.candidate' ||
    final.value?.type !== 'identity.candidate'
  ) {
    assert.fail('Expected partial and final identity candidates');
  }
  assert.equal(partial.value.payload.level, 'brand_category');
  assert.equal(final.value.payload.productName, 'Kindle');
  assert.equal(final.value.revision, partial.value.revision + 1);

  await events.return(undefined);
});

test('accepts three JPEG views in one multipart identification request', async () => {
  const app = createApiApp({
    identifyImage: async ({ images }) => {
      assert.equal(images.length, 3);
      assert.deepEqual(
        images.map((image) => [...image.imageBytes]),
        [[1], [2], [3]],
      );
      return {
        requestId: 'gateway-request-multi',
        model: 'google/gemini-3.7-flash',
        latencyMs: 300,
        inference: {
          level: 'product_family',
          category: 'game controller',
          brand: 'Sony',
          productName: 'DualSense',
          model: null,
          variant: 'white',
          confidence: 0.93,
          visibleText: [],
          visualEvidence: ['symmetrical sticks', 'central touchpad'],
          alternative: 'Xbox Wireless Controller has offset sticks',
          searchQuery: null,
        },
      };
    },
  });
  const formData = new FormData();
  formData.append('images', new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), 'one.jpg');
  formData.append('images', new Blob([new Uint8Array([2])], { type: 'image/jpeg' }), 'two.jpg');
  formData.append('images', new Blob([new Uint8Array([3])], { type: 'image/jpeg' }), 'three.jpg');

  const response = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: {
      'x-snap-image-id': 'image-1',
      'x-snap-item-intent-id': 'item-1',
      'x-snap-session-id': 'session-1',
    },
    body: formData,
  });

  assert.equal(response.status, 200);
  const events = await readIdentifyStream(response);
  const result = events.find((event) => event.type === 'result');
  assert.equal(result?.type, 'result');
  if (result?.type !== 'result') assert.fail('Expected an identity result');
  assert.equal(result.response.signals.imageCount, 3);
  assert.deepEqual(result.response.signals.visualEvidence, [
    'symmetrical sticks',
    'central touchpad',
  ]);
});

test('rejects an item after the session request ceiling is reached', async () => {
  const app = createApiApp({
    providerBudget: new ProviderRequestBudget({
      maxConcurrentRequests: 1,
      maxRequestsPerSession: 1,
    }),
    identifyImage: async () => ({
      requestId: 'gateway-request-1',
      model: 'google/gemini-3.7-flash',
      latencyMs: 1,
      inference: {
        level: 'category',
        category: 'bottle',
        brand: null,
        productName: null,
        model: null,
        variant: null,
        confidence: 0.5,
        visibleText: [],
        searchQuery: null,
      },
    }),
  });

  const first = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: requestHeaders,
    body: new Uint8Array([1]),
  });
  const second = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: { ...requestHeaders, 'x-snap-image-id': 'image-2' },
    body: new Uint8Array([2]),
  });

  assert.equal(first.status, 200);
  await first.body?.cancel();
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, 'session_request_limit');
});

test('flushes an accepted event before identification completes', async () => {
  let finishIdentification: ((result: VisualIdentityResult) => void) | undefined;
  const identification = new Promise<VisualIdentityResult>((resolve) => {
    finishIdentification = resolve;
  });
  const app = createApiApp({ identifyImage: async () => identification });

  const response = await app.request('http://localhost/v1/identify', {
    method: 'POST',
    headers: requestHeaders,
    body: new Uint8Array([1]),
  });
  const reader = response.body?.getReader();
  assert.ok(reader);

  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  const accepted = IdentifyStreamEventSchema.parse(
    JSON.parse(new TextDecoder().decode(firstChunk.value).trim()),
  );
  assert.equal(accepted.type, 'accepted');

  finishIdentification?.({
    requestId: 'gateway-request-2',
    model: 'google/gemini-3.7-flash',
    latencyMs: 200,
    inference: {
      level: 'category',
      category: 'bottle',
      brand: null,
      productName: null,
      model: null,
      variant: null,
      confidence: 0.6,
      visibleText: [],
      searchQuery: null,
    },
  });

  const secondChunk = await reader.read();
  assert.equal(secondChunk.done, false);
  const result = IdentifyStreamEventSchema.parse(
    JSON.parse(new TextDecoder().decode(secondChunk.value).trim()),
  );
  assert.equal(result.type, 'result');
  await reader.cancel();
});
