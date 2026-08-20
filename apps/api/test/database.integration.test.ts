import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { createDatabaseClient } from '../src/database/client.ts';
import { sessions } from '../src/database/schema.ts';

test(
  'runs a typed Drizzle transaction against the local Supabase schema',
  { skip: process.env.DATABASE_URL === undefined },
  async () => {
    const client = createDatabaseClient();
    const sessionId = `integration-${randomUUID()}`;

    try {
      await client.db.transaction(async (transaction) => {
        await transaction.insert(sessions).values({
          id: sessionId,
          deviceId: 'integration-device',
          startedAt: '2026-08-20T12:00:00.000Z',
        });

        const [stored] = await transaction
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);

        assert.equal(stored?.status, 'active');
        assert.equal(stored?.deviceId, 'integration-device');

        await transaction.delete(sessions).where(eq(sessions.id, sessionId));
      });
    } finally {
      await client.close();
    }
  },
);
