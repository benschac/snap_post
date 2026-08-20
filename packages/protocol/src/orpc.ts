import { type ContractRouterClient, eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';

import { ClientEventSchema, ServerEventSchema } from './events.ts';

export const EventReceiptSchema = z.object({
  eventId: z.string().min(1),
  receivedAt: z.iso.datetime({ offset: true }),
});

export const SessionEventSubscriptionSchema = z.object({
  sessionId: z.string().min(1),
  afterRevision: z.number().int().nonnegative().optional(),
});

export const controlContract = {
  control: {
    publish: oc.input(ClientEventSchema).output(EventReceiptSchema),
    subscribe: oc
      .input(SessionEventSubscriptionSchema)
      .output(eventIterator(ServerEventSchema)),
  },
};

export type ControlContractClient = ContractRouterClient<
  typeof controlContract
>;
export type EventReceipt = z.infer<typeof EventReceiptSchema>;
export type SessionEventSubscription = z.infer<
  typeof SessionEventSubscriptionSchema
>;
