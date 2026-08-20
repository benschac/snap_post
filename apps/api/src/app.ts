import { upgradeWebSocket } from '@hono/node-server';
import { CONTROL_PROTOCOL_VERSION, HealthResponseSchema } from '@snap/protocol';
import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (context) =>
  context.json(
    HealthResponseSchema.parse({
      service: 'snap-api',
      status: 'ok',
      protocolVersion: CONTROL_PROTOCOL_VERSION,
    }),
  ),
);

app.get(
  '/v1/control',
  upgradeWebSocket(() => ({})),
);

app.notFound((context) =>
  context.json({ error: 'not_found' }, 404),
);

app.onError((error, context) => {
  console.error('Unhandled API error', error);
  return context.json({ error: 'internal_error' }, 500);
});
