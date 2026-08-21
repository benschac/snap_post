import type { Observable } from '@legendapp/state';
import { File } from 'expo-file-system';
import { useCallback, useRef, type RefObject } from 'react';

import { identifyItemImages } from '../backend/backend-client';
import { formatError } from './format-error';
import { formatIdentityCandidate } from './identity-format';
import type { SliceOneViewState } from './slice-one-view-state';
import type { SessionItem } from './slice-one-types';
import type { SliceTrace } from './trace';

const IDENTIFICATION_IMAGE_LIMIT = 2;

type ItemRequestState = {
  completedCaptureKey?: string;
  desiredCaptureKey?: string;
  inFlight: boolean;
  pendingItem?: SessionItem;
};

function captureKey(item: SessionItem) {
  return item.captures
    .slice(0, IDENTIFICATION_IMAGE_LIMIT)
    .map((capture) => capture.id)
    .join(':');
}

function snapshotItem(item: SessionItem): SessionItem {
  return { ...item, captures: [...item.captures] };
}

type UseSliceOneIdentificationOptions = {
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneIdentification({
  state$,
  traceRef,
}: UseSliceOneIdentificationOptions) {
  const requestStatesRef = useRef(new Map<string, ItemRequestState>());

  const reset = useCallback(() => {
    requestStatesRef.current.clear();
    state$.identityRequestImageIds.set({});
    state$.identityRequestTimings.set({});
    state$.identificationStatus.set('Identity API waiting for a selected image');
  }, [state$]);

  const identifyItem = useCallback(async (item: SessionItem) => {
    const trace = traceRef.current;
    const sessionId = trace?.sessionId;
    const requestedItem = snapshotItem(item);
    const primaryCapture = requestedItem.captures[0];
    if (!sessionId || !primaryCapture) {
      trace?.mark('identity.skipped', {
        itemIndex: item.itemIndex,
        reason: 'no-selected-images',
      });
      return;
    }

    const requestKey = `${sessionId}:${item.itemIndex}`;
    const nextCaptureKey = captureKey(requestedItem);
    const itemIntentId = `item-${item.itemIndex}`;
    const requestState = requestStatesRef.current.get(requestKey) ?? {
      inFlight: false,
    };
    requestStatesRef.current.set(requestKey, requestState);
    requestState.desiredCaptureKey = nextCaptureKey;
    requestState.pendingItem = requestedItem;
    state$.identityRequestImageIds.set({
      ...state$.identityRequestImageIds.peek(),
      [itemIntentId]: primaryCapture.id,
    });

    if (requestState.completedCaptureKey === nextCaptureKey) return;
    if (requestState.inFlight) {
      trace.mark('identity.request_queued', {
        captureKey: nextCaptureKey,
        imageId: primaryCapture.id,
        itemIndex: item.itemIndex,
      });
      return;
    }

    requestState.inFlight = true;
    try {
      while (requestState.pendingItem) {
        const currentItem = requestState.pendingItem;
        requestState.pendingItem = undefined;
        const currentCaptureKey = captureKey(currentItem);
        if (requestState.completedCaptureKey === currentCaptureKey) continue;

        const captures = currentItem.captures.slice(0, IDENTIFICATION_IMAGE_LIMIT);
        const currentPrimaryCapture = captures[0];
        if (!currentPrimaryCapture) continue;
        const requestStartedAtMs = performance.now();
        state$.identityRequestTimings.set({
          ...state$.identityRequestTimings.peek(),
          [itemIntentId]: {
            captureRequestedAtMs: currentPrimaryCapture.captureRequestedAtMs,
            requestStartedAtMs,
          },
        });
        state$.identificationStatus.set(`Item ${currentItem.itemIndex} · identifying…`);
        trace.mark('identity.requested', {
          captureKey: currentCaptureKey,
          imageId: currentPrimaryCapture.id,
          imageCount: captures.length,
          imageIds: captures.map((capture) => capture.id).join(','),
          itemIndex: currentItem.itemIndex,
          speculative: !currentItem.finalized,
        });

        try {
          const imageFiles = captures.map((capture) => new File(capture.fileUri));
          if (imageFiles.some((imageFile) => !imageFile.exists)) {
            throw new Error('A selected identification image no longer exists');
          }
          const imageBytes = imageFiles.reduce((total, imageFile) => total + imageFile.size, 0);
          trace.mark('identity.upload_started', {
            captureKey: currentCaptureKey,
            imageBytes,
            imageCount: imageFiles.length,
            imageId: currentPrimaryCapture.id,
            itemIndex: currentItem.itemIndex,
          });

          const { metrics: requestMetrics, response: result } = await identifyItemImages({
            sessionId,
            itemIntentId,
            imageId: currentPrimaryCapture.id,
            images: imageFiles,
            onEvent: (event, elapsedMs) => {
              if (
                event.type !== 'accepted' ||
                traceRef.current?.sessionId !== sessionId ||
                requestState.desiredCaptureKey !== currentCaptureKey
              ) return;
              state$.identificationStatus.set(
                `Item ${currentItem.itemIndex} · ${imageFiles.length} view${imageFiles.length === 1 ? '' : 's'} uploaded · analyzing…`
              );
              trace.mark('identity.request_accepted', {
                captureKey: currentCaptureKey,
                imageId: currentPrimaryCapture.id,
                imageCount: imageFiles.length,
                itemIndex: currentItem.itemIndex,
                acceptedAt: event.acceptedAt,
                firstEventMs: elapsedMs,
              });
              trace.mark('identity.upload_completed', {
                captureKey: currentCaptureKey,
                imageBytes,
                imageCount: imageFiles.length,
                imageId: currentPrimaryCapture.id,
                itemIndex: currentItem.itemIndex,
                uploadAndParseMs: elapsedMs,
              });
            },
          });
          requestState.completedCaptureKey = currentCaptureKey;
          if (
            traceRef.current?.sessionId !== sessionId ||
            requestState.desiredCaptureKey !== currentCaptureKey
          ) {
            trace.mark('identity.result_stale', {
              captureKey: currentCaptureKey,
              imageId: currentPrimaryCapture.id,
              itemIndex: currentItem.itemIndex,
            });
            continue;
          }

          const label = formatIdentityCandidate(result.candidate);
          state$.identificationStatus.set(
            `Item ${currentItem.itemIndex} · ${label} · ${(result.candidate.confidence * 100).toFixed(0)}% · ${requestMetrics.imageCount} view${requestMetrics.imageCount === 1 ? '' : 's'} · ${result.provider.latencyMs.toFixed(0)} ms`
          );
          trace.mark('identity.candidate_received', {
            captureKey: currentCaptureKey,
            imageId: currentPrimaryCapture.id,
            imageIds: captures.map((capture) => capture.id).join(','),
            itemIndex: currentItem.itemIndex,
            level: result.candidate.level,
            category: result.candidate.category,
            brand: result.candidate.brand,
            productName: result.candidate.productName,
            model: result.candidate.model,
            variant: result.candidate.variant,
            confidence: result.candidate.confidence,
            provider: result.provider.name,
            providerModel: result.provider.model,
            providerLatencyMs: result.provider.latencyMs,
            firstEventMs: requestMetrics.firstEventMs,
            endToEndMs: requestMetrics.endToEndMs,
            imageBytes: requestMetrics.imageBytes,
            imageCount: requestMetrics.imageCount,
            roundTripOverheadMs: requestMetrics.roundTripOverheadMs,
            visibleText: result.signals.visibleText.join(' | '),
            visualEvidence: result.signals.visualEvidence?.join(' | '),
            alternative: result.signals.alternative,
            searchQuery: result.signals.searchQuery,
          });
        } catch (error) {
          requestState.completedCaptureKey = currentCaptureKey;
          if (
            traceRef.current?.sessionId !== sessionId ||
            requestState.desiredCaptureKey !== currentCaptureKey
          ) continue;
          const message = formatError(error);
          state$.identificationStatus.set(
            `Item ${currentItem.itemIndex} · identity failed: ${message}`
          );
          trace.mark('identity.error', {
            captureKey: currentCaptureKey,
            imageId: currentPrimaryCapture.id,
            itemIndex: currentItem.itemIndex,
            message,
          });
        }
      }
    } finally {
      requestState.inFlight = false;
    }
  }, [state$, traceRef]);

  return { identifyItem, reset };
}
