import assert from 'node:assert/strict';
import test from 'node:test';

import { MockLanguageModelV4 } from 'ai/test';

import {
  applyIdentityConfidenceGuardrails,
  identifyVisualItem,
  VisualIdentityError,
} from '../src/providers/visual-identity.ts';

const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};

function mockIdentityModel(
  inference: Record<string, unknown>,
  options: { requestId?: string; responseModel?: string } = {},
) {
  return new MockLanguageModelV4({
    provider: 'gateway',
    modelId: 'configured-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(inference) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
      response: {
        id: options.requestId,
        modelId: options.responseModel,
      },
    }),
  });
}

const kindleInference = {
  level: 'product_family',
  category: 'e-reader',
  brand: 'Amazon',
  productName: 'Kindle',
  model: null,
  variant: null,
  confidence: 0.82,
  visibleText: ['kindle'],
  searchQuery: 'Amazon Kindle e-reader',
};

test('sends a JPEG directly to the AI SDK and returns structured identity metadata', async () => {
  const model = mockIdentityModel(kindleInference, {
    requestId: 'gateway-request-1',
    responseModel: 'google/gemini-3.7-flash',
  });
  const result = await identifyVisualItem(
    {
      images: [
        {
          contentType: 'image/jpeg',
          imageBytes: new Uint8Array([1, 2, 3]),
        },
      ],
    },
    { model: 'google/gemini-3.7-flash' },
    { languageModel: model },
  );

  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0];
  assert.equal(call?.responseFormat?.type, 'json');
  assert.equal(call?.reasoning, 'minimal');
  const message = call?.prompt[0];
  assert.equal(message?.role, 'user');
  assert.ok(Array.isArray(message?.content));
  const file = message.content.find((part) => part.type === 'file');
  assert.equal(file?.mediaType, 'image/jpeg');
  assert.equal(file?.data.type, 'data');
  if (file?.data.type !== 'data') assert.fail('Expected inline image bytes');
  assert.deepEqual(file.data.data, new Uint8Array([1, 2, 3]));
  assert.equal(result.requestId, 'gateway-request-1');
  assert.equal(result.model, 'google/gemini-3.7-flash');
  assert.equal(result.inference.productName, 'Kindle');
  assert.equal(result.reportedConfidence, 0.82);
});

test('fails before making a request when Gateway credentials are missing', async () => {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;

  try {
    await assert.rejects(
      identifyVisualItem({
        images: [{ contentType: 'image/jpeg', imageBytes: new Uint8Array([1]) }],
      }),
      (error: unknown) =>
        error instanceof VisualIdentityError &&
        error.code === 'provider_unconfigured',
    );
  } finally {
    if (apiKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = apiKey;
    if (oidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = oidcToken;
  }
});

test('maps invalid structured model output to provider_error', async () => {
  const model = mockIdentityModel({
    level: 'product_family',
    category: 'controller',
    confidence: 84,
  });

  await assert.rejects(
    identifyVisualItem(
      { images: [{ contentType: 'image/jpeg', imageBytes: new Uint8Array([1]) }] },
      {},
      { languageModel: model },
    ),
    (error: unknown) =>
      error instanceof VisualIdentityError && error.code === 'provider_error',
  );
});

test('maps an aborted model request to provider_timeout', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) =>
      await new Promise((_, reject) => {
        abortSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  });

  await assert.rejects(
    identifyVisualItem(
      { images: [{ contentType: 'image/jpeg', imageBytes: new Uint8Array([1]) }] },
      { timeoutMs: 5 },
      { languageModel: model },
    ),
    (error: unknown) =>
      error instanceof VisualIdentityError && error.code === 'provider_timeout',
  );
});

test('sends up to three same-item views and preserves confidence guardrails', async () => {
  const model = mockIdentityModel({
    level: 'product_family',
    category: 'game controller',
    brand: 'Sony',
    productName: 'DualSense',
    model: null,
    variant: 'white',
    confidence: 0.93,
    visibleText: [],
    visualEvidence: ['symmetrical analog sticks', 'large central touchpad'],
    alternative: 'Xbox Wireless Controller lacks the central touchpad',
    searchQuery: 'Sony DualSense white controller',
  });
  const result = await identifyVisualItem(
    {
      images: [1, 2, 3].map((byte) => ({
        contentType: 'image/jpeg' as const,
        imageBytes: new Uint8Array([byte]),
      })),
    },
    {},
    { languageModel: model },
  );

  const content = model.doGenerateCalls[0]?.prompt[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((part) => part.type === 'file').length, 3);
  assert.equal(result.reportedConfidence, 0.93);
  assert.equal(result.inference.confidence, 0.85);
});

test('rejects an unsupported number of input images', async () => {
  await assert.rejects(
    identifyVisualItem({ images: [] }, {}, {
      languageModel: mockIdentityModel(kindleInference),
    }),
    (error: unknown) =>
      error instanceof VisualIdentityError &&
      error.message.includes('between 1 and 3 images'),
  );
});

test('caps unsupported product confidence without readable or visual evidence', () => {
  const inference = applyIdentityConfidenceGuardrails(
    {
      level: 'product_family',
      category: 'game controller',
      brand: 'Microsoft',
      productName: 'Xbox Wireless Controller',
      model: null,
      variant: null,
      confidence: 0.95,
      visibleText: [],
      searchQuery: 'Microsoft Xbox Wireless Controller',
    },
    3,
  );

  assert.equal(inference.confidence, 0.65);
});
