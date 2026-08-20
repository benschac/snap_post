import {
  controlContract,
  type ServerEvent,
} from '@snap/protocol';
import { EventPublisher, implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/ws';

import { createControlResponse } from './control.ts';

const serverEvents = new EventPublisher<Record<string, ServerEvent>>();
const os = implement(controlContract);

export function publishServerEvent(event: ServerEvent): void {
  serverEvents.publish(event.sessionId, event);
}

const publish = os.control.publish.handler(({ input }) => {
  const receivedAt = new Date().toISOString();

  if (input.type === 'control.ping') {
    publishServerEvent(
      createControlResponse(input, { serverTimestamp: receivedAt }),
    );
  }

  return {
    eventId: input.eventId,
    receivedAt,
  };
});

const subscribe = os.control.subscribe.handler(async function* ({
  input,
  signal,
}) {
  const events = serverEvents.subscribe(input.sessionId, { signal });

  for await (const event of events) {
    if (
      input.afterRevision === undefined ||
      event.revision > input.afterRevision
    ) {
      yield event;
    }
  }
});

export const controlRouter = os.router({
  control: {
    publish,
    subscribe,
  },
});

export const controlRpcHandler = new RPCHandler(controlRouter);
