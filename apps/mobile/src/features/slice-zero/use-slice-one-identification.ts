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

type UseSliceOneIdentificationOptions = {
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneIdentification({
  state$,
  traceRef,
}: UseSliceOneIdentificationOptions) {
  const requestedItemsRef = useRef(new Set<string>());

  const reset = useCallback(() => {
    requestedItemsRef.current.clear();
    state$.identificationStatus.set('Identity API waiting for a completed item');
  }, [state$]);

  const identifyItem = useCallback(async (item: SessionItem) => {
    const trace = traceRef.current;
    const sessionId = trace?.sessionId;
    const captures = item.captures.slice(0, IDENTIFICATION_IMAGE_LIMIT);
    const primaryCapture = captures[0];
    if (!sessionId || !primaryCapture) {
      trace?.mark('identity.skipped', {
        itemIndex: item.itemIndex,
        reason: 'no-selected-images',
      });
      return;
    }

    const requestKey = `${sessionId}:${item.itemIndex}`;
    if (requestedItemsRef.current.has(requestKey)) return;
    requestedItemsRef.current.add(requestKey);

    state$.identificationStatus.set(`Item ${item.itemIndex} · identifying with Groq…`);
    trace.mark('identity.requested', {
      imageId: primaryCapture.id,
      imageCount: captures.length,
      imageIds: captures.map((capture) => capture.id).join(','),
      itemIndex: item.itemIndex,
    });

    try {
      const imageFiles = captures.map((capture) => new File(capture.fileUri));
      if (imageFiles.some((imageFile) => !imageFile.exists)) {
        throw new Error('A selected identification image no longer exists');
      }

      const { metrics: requestMetrics, response: result } = await identifyItemImages({
        sessionId,
        itemIntentId: `item-${item.itemIndex}`,
        imageId: primaryCapture.id,
        images: imageFiles,
        onEvent: (event, elapsedMs) => {
          if (event.type !== 'accepted' || traceRef.current?.sessionId !== sessionId) return;
          state$.identificationStatus.set(
            `Item ${item.itemIndex} · ${imageFiles.length} view${imageFiles.length === 1 ? '' : 's'} uploaded · Groq analyzing…`
          );
          trace.mark('identity.request_accepted', {
            imageId: primaryCapture.id,
            imageCount: imageFiles.length,
            itemIndex: item.itemIndex,
            acceptedAt: event.acceptedAt,
            firstEventMs: elapsedMs,
          });
        },
      });
      if (traceRef.current?.sessionId !== sessionId) return;

      const label = formatIdentityCandidate(result.candidate);
      state$.identificationStatus.set(
        `Item ${item.itemIndex} · ${label} · ${(result.candidate.confidence * 100).toFixed(0)}% · ${requestMetrics.imageCount} view${requestMetrics.imageCount === 1 ? '' : 's'} · ${result.provider.latencyMs.toFixed(0)} ms`
      );
      trace.mark('identity.candidate_received', {
        imageId: primaryCapture.id,
        imageIds: captures.map((capture) => capture.id).join(','),
        itemIndex: item.itemIndex,
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
      if (traceRef.current?.sessionId !== sessionId) return;
      const message = formatError(error);
      state$.identificationStatus.set(`Item ${item.itemIndex} · identity failed: ${message}`);
      trace.mark('identity.error', {
        imageId: primaryCapture.id,
        itemIndex: item.itemIndex,
        message,
      });
    }
  }, [state$, traceRef]);

  return { identifyItem, reset };
}
