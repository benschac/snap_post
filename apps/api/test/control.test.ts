import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlResponse } from '../src/control.ts';

test('returns a bounded protocol error for malformed input', () => {
  const response = createControlResponse(
    { sessionId: 'session-1', revision: 4 },
    {
      eventId: 'server-event-1',
      serverTimestamp: '2026-08-20T12:00:01.000Z',
    },
  );

  assert.equal(response.type, 'control.error');
  assert.equal(response.sessionId, 'session-1');
  assert.equal(response.revision, 4);
  assert.equal(response.payload.code, 'invalid_event');
});
