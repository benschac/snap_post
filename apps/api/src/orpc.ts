import { controlContract } from '@snap/protocol';
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/ws';

import { createControlResponse } from './control.ts';
import type { Database } from './database/client.ts';
import {
  EventIdReuseError,
  EventParentNotFoundError,
  persistDomainEvent,
  UnsupportedDomainEventError,
} from './database/event-ingestion.ts';
import { ServerEventBroker } from './server-events.ts';

const os = implement(controlContract);

export type ControlRouterOptions = {
  database?: Database;
  serverEvents?: ServerEventBroker;
};

export function createControlRouter(options: ControlRouterOptions = {}) {
  const serverEvents = options.serverEvents ?? new ServerEventBroker();

  const publish = os.control.publish.handler(async ({ input }) => {
    if (input.type === 'control.ping') {
      const receivedAt = new Date().toISOString();
      serverEvents.publish(
        createControlResponse(input, {
          revision: serverEvents.nextRevision(input.sessionId),
          serverTimestamp: receivedAt,
        }),
      );
      return { eventId: input.eventId, receivedAt };
    }

    if (options.database === undefined) {
      throw new ORPCError('SERVICE_UNAVAILABLE', {
        message: 'Durable event ingestion is not configured',
      });
    }

    try {
      return await persistDomainEvent(options.database, input);
    } catch (error) {
      if (error instanceof EventIdReuseError) {
        throw new ORPCError('CONFLICT', {
          message: error.message,
          cause: error,
        });
      }
      if (error instanceof EventParentNotFoundError) {
        throw new ORPCError('NOT_FOUND', {
          message: error.message,
          cause: error,
        });
      }
      if (error instanceof UnsupportedDomainEventError) {
        throw new ORPCError('NOT_IMPLEMENTED', {
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
  });

  const subscribe = os.control.subscribe.handler(async function* ({
    input,
    signal,
  }) {
    const events = serverEvents.subscribe(input.sessionId, signal);

    for await (const event of events) {
      if (
        input.afterRevision === undefined ||
        event.revision > input.afterRevision
      ) {
        yield event;
      }
    }
  });

  return os.router({
    control: {
      publish,
      subscribe,
    },
  });
}

export function createControlRpcHandler(options: ControlRouterOptions = {}) {
  return new RPCHandler(createControlRouter(options));
}
