import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExaSearchError,
  searchExa,
} from '../src/providers/exa-search.ts';

test('uses instant Exa search and parses raw evidence candidates', async () => {
  const result = await searchExa('Amazon Kindle e-reader', {
    apiKey: 'test-key',
    fetchImpl: async (input, init) => {
      assert.equal(input, 'https://api.exa.ai/search');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'test-key');

      const body = JSON.parse(String(init?.body));
      assert.equal(body.query, 'Amazon Kindle e-reader');
      assert.equal(body.type, 'instant');
      assert.equal(body.numResults, 4);
      assert.equal(body.outputSchema, undefined);

      return Response.json({
        requestId: 'exa-request-1',
        results: [
          {
            id: 'result-1',
            title: 'Amazon Kindle',
            url: 'https://www.amazon.com/kindle',
            highlights: ['A Kindle product page'],
          },
        ],
      });
    },
  });

  assert.equal(result.requestId, 'exa-request-1');
  assert.equal(result.results[0]?.title, 'Amazon Kindle');
  assert.equal(result.results[0]?.highlights[0], 'A Kindle product page');
});

test('fails before making a request when the Exa key is missing', async () => {
  await assert.rejects(
    searchExa('Kindle', { apiKey: '' }),
    (error: unknown) =>
      error instanceof ExaSearchError &&
      error.code === 'provider_unconfigured',
  );
});
