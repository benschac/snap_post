import type { Observable } from '@legendapp/state';
import type { ServerEvent } from '@snap/protocol';
import { useCallback, useRef } from 'react';

import {
  createControlClient,
  resolveControlSocketUrl,
} from '../backend/backend-client';
import { formatError } from './format-error';
import { formatIdentityCandidate } from './identity-format';
import type { SliceOneViewState } from './slice-one-view-state';
import type { SliceTrace } from './trace';

export function useSliceOneControlStream(state$: Observable<SliceOneViewState>) {
  const socketRef = useRef<WebSocket | null>(null);
  const subscriptionRef = useRef<AsyncIterator<ServerEvent> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const close = useCallback(() => {
    const subscription = subscriptionRef.current;
    subscriptionRef.current = null;
    if (subscription?.return) void subscription.return(undefined);

    const socket = socketRef.current;
    socketRef.current = null;
    sessionIdRef.current = null;
    socket?.close();
  }, []);

  const connect = useCallback(
    async (sessionId: string, trace: SliceTrace) => {
      close();
      sessionIdRef.current = sessionId;
      trace.mark('control.connecting');

      try {
        const socket = new WebSocket(resolveControlSocketUrl());
        socketRef.current = socket;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Control WebSocket connection timed out')),
            5_000
          );
          socket.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('Control WebSocket connection failed'));
          };
        });
        if (sessionIdRef.current !== sessionId) {
          socket.close();
          return;
        }

        trace.mark('control.connected');
        socket.onerror = () => trace.mark('control.error');
        socket.onclose = (event) => {
          trace.mark('control.closed', { code: event.code, reason: event.reason });
        };

        const client = createControlClient(socket);
        const events = await client.control.subscribe({ sessionId });
        subscriptionRef.current = events;

        for await (const event of events) {
          if (sessionIdRef.current !== sessionId) break;

          if (event.type === 'identity.candidate') {
            const expectedImageId = state$.identityRequestImageIds.peek()[event.itemIntentId];
            if (
              expectedImageId &&
              !event.payload.candidateId.includes(`:${expectedImageId}:`)
            ) {
              trace.mark('identity.candidate_stale', {
                candidateId: event.payload.candidateId,
                expectedImageId,
                itemIntentId: event.itemIntentId,
                revision: event.revision,
              });
              continue;
            }
            const label = formatIdentityCandidate(event.payload);
            const timing = state$.identityRequestTimings.peek()[event.itemIntentId];
            const candidateReceivedAtMs = performance.now();
            const requestToValidCandidateMs = timing
              ? candidateReceivedAtMs - timing.requestStartedAtMs
              : undefined;
            const captureToValidCandidateMs = timing
              ? candidateReceivedAtMs - timing.captureRequestedAtMs
              : undefined;
            state$.identificationStatus.set(
              `${event.itemIntentId} · ${label} · ${(event.payload.confidence * 100).toFixed(0)}%${
                requestToValidCandidateMs === undefined
                  ? ''
                  : ` · ${requestToValidCandidateMs.toFixed(0)} ms`
              }`
            );
            trace.mark('identity.candidate_streamed', {
              itemIntentId: event.itemIntentId,
              category: event.payload.category,
              brand: event.payload.brand,
              productName: event.payload.productName,
              confidence: event.payload.confidence,
              captureToValidCandidateMs,
              requestToValidCandidateMs,
              revision: event.revision,
            });
            continue;
          }

          if (event.type === 'evidence.patch') {
            const webCandidates = event.payload.claims.find(
              (claim) => claim.path === 'web.candidates'
            )?.value;
            const candidateCount = Array.isArray(webCandidates) ? webCandidates.length : 0;
            const firstCandidate = Array.isArray(webCandidates) ? webCandidates[0] : undefined;
            const firstTitle =
              firstCandidate && typeof firstCandidate === 'object'
                ? Reflect.get(firstCandidate, 'title')
                : undefined;
            const firstUrl =
              firstCandidate && typeof firstCandidate === 'object'
                ? Reflect.get(firstCandidate, 'url')
                : undefined;
            state$.identificationStatus.set(
              `${event.itemIntentId} · ${
                typeof firstTitle === 'string'
                  ? firstTitle
                  : `${candidateCount} web candidates`
              } · ${event.payload.provider?.latencyMs.toFixed(0) ?? '—'} ms`
            );
            trace.mark('evidence.patch_received', {
              itemIntentId: event.itemIntentId,
              candidateCount,
              claimCount: event.payload.claims.length,
              firstTitle: typeof firstTitle === 'string' ? firstTitle : undefined,
              firstUrl: typeof firstUrl === 'string' ? firstUrl : undefined,
              provider: event.payload.provider?.name,
              providerLatencyMs: event.payload.provider?.latencyMs,
              revision: event.revision,
            });
            continue;
          }

          if (event.type === 'task.failed') {
            state$.identificationStatus.set(
              `${event.itemIntentId} · evidence unavailable: ${event.payload.message}`
            );
            trace.mark('identity.background_task_failed', {
              itemIntentId: event.itemIntentId,
              taskId: event.payload.taskId,
              code: event.payload.code,
              message: event.payload.message,
              retryable: event.payload.retryable,
              revision: event.revision,
            });
          }
        }
      } catch (error) {
        if (sessionIdRef.current !== sessionId) return;
        trace.mark('control.connection_failed', { message: formatError(error) });
        close();
      }
    },
    [close, state$]
  );

  return { close, connect };
}
