import { EventPublisher } from '@orpc/server';
import { ServerEventSchema, type ServerEvent } from '@snap/protocol';

export class ServerEventBroker {
  private readonly publisher = new EventPublisher<Record<string, ServerEvent>>();
  private readonly nextRevisionBySession = new Map<string, number>();

  nextRevision(sessionId: string): number {
    const revision = this.nextRevisionBySession.get(sessionId) ?? 0;
    this.nextRevisionBySession.set(sessionId, revision + 1);
    return revision;
  }

  publish(event: ServerEvent): void {
    const parsed = ServerEventSchema.parse(event);
    this.publisher.publish(parsed.sessionId, parsed);
  }

  subscribe(sessionId: string, signal?: AbortSignal) {
    return this.publisher.subscribe(sessionId, { signal });
  }
}
