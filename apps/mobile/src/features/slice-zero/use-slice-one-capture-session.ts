import type { Observable } from '@legendapp/state';
import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraPhotoOutput } from 'react-native-vision-camera';
import { Presets } from 'react-native-pulsar';
import {
  ReduceMotion,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { FrameQualitySample } from '../slice-one/capture-policy';
import {
  createCaptureItem,
  finalizeCaptureItem,
  replaceItemCaptures,
} from '../slice-one/item-session';
import type { ObjectTrack } from '../slice-one/object-tracker';
import { formatError } from './format-error';
import type { SliceOneViewState } from './slice-one-view-state';
import type { RetainedCapture, SessionItem } from './slice-one-types';
import type { SliceTrace } from './trace';

type ShadowCaptureSummary = {
  labelAgnosticSelectedCaptureIds: string;
  labelAgnosticSelectedCaptures: number;
  salientObjectSelectedCaptureIds: string;
  salientObjectSelectedCaptures: number;
};

type UseSliceOneCaptureSessionOptions = {
  activeItemRef: RefObject<SessionItem>;
  captureFeedback: SharedValue<number>;
  captureInFlightRef: RefObject<boolean>;
  getShadowCaptureSummary: () => ShadowCaptureSummary;
  identifyItem: (item: SessionItem) => Promise<void>;
  isCameraSwitching: () => boolean;
  onItemReset: () => void;
  photoOutput: CameraPhotoOutput;
  sessionState: SliceOneViewState['sessionState'];
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

function makeCaptureId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileUriToPath(uri: string) {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

export function useSliceOneCaptureSession({
  activeItemRef,
  captureFeedback,
  captureInFlightRef,
  getShadowCaptureSummary,
  identifyItem,
  isCameraSwitching,
  onItemReset,
  photoOutput,
  sessionState,
  state$,
  traceRef,
}: UseSliceOneCaptureSessionOptions) {
  const [selectedCaptures, setSelectedCaptures] = useState<RetainedCapture[]>([]);
  const activeCapturePromiseRef = useRef<Promise<void> | null>(null);
  const completedItemsRef = useRef<SessionItem[]>([]);
  const selectedCapturesRef = useRef<RetainedCapture[]>([]);
  const sessionDirectoryRef = useRef<Directory | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => () => {
    selectedCapturesRef.current = [];
  }, []);

  const resetCurrentItem = useCallback((itemIndex: number) => {
    const item = createCaptureItem<RetainedCapture>(itemIndex);
    activeItemRef.current = item;
    selectedCapturesRef.current = item.captures;
    setSelectedCaptures([]);
    onItemReset();
    state$.qualityGateStatus.set('Waiting for a stable view');
    state$.captureStatus.set('No photos selected for this item');
    return item;
  }, [activeItemRef, onItemReset, state$]);

  const resetForSession = useCallback(() => {
    captureInFlightRef.current = false;
    stopRequestedRef.current = false;
    state$.isCapturing.set(false);
  }, [captureInFlightRef, state$]);

  const initialize = useCallback((sessionId: string) => {
    resetCurrentItem(1);
    completedItemsRef.current = [];
    state$.currentItemIndex.set(1);
    const sessionDirectory = new Directory(Paths.document, 'slice-one', sessionId);
    sessionDirectory.create({ idempotent: true, intermediates: true });
    sessionDirectoryRef.current = sessionDirectory;
    traceRef.current?.mark('item.started', { itemIndex: 1 });
  }, [resetCurrentItem, state$, traceRef]);

  const finalizeCurrentItem = useCallback(() => {
    const item = activeItemRef.current;
    if (item.finalized) return item;

    replaceItemCaptures(
      item,
      item.captures.map((capture) => ({ ...capture, previewImage: undefined }))
    );
    finalizeCaptureItem(item);
    completedItemsRef.current.push(item);
    traceRef.current?.mark('item.completed', {
      itemIndex: item.itemIndex,
      selectedCaptures: item.captures.length,
      selectedCaptureIds: item.captures.map((capture) => capture.id).join(','),
      needsReview: item.needsReview,
      ...getShadowCaptureSummary(),
    });
    return item;
  }, [activeItemRef, getShadowCaptureSummary, traceRef]);

  const captureAutoCandidate = useCallback(
    async (sample: FrameQualitySample, track: ObjectTrack, replaceCaptureId?: string) => {
      if (
        sessionState !== 'running' ||
        captureInFlightRef.current ||
        isCameraSwitching()
      ) {
        return;
      }
      const sessionDirectory = sessionDirectoryRef.current;
      if (!sessionDirectory) return;

      const item = activeItemRef.current;
      captureInFlightRef.current = true;
      state$.isCapturing.set(true);
      const imageId = makeCaptureId();
      const requestAt = performance.now();
      let previewImage: RetainedCapture['previewImage'];
      let persistedFile: File | undefined;
      let previewFile: File | undefined;
      let previewSavePromise: Promise<void> | undefined;
      traceRef.current?.mark('capture.auto_requested', {
        imageId,
        cameraPosition: state$.cameraPosition.peek(),
        itemIndex: item.itemIndex,
        qualityScore: sample.qualityScore,
        replacing: replaceCaptureId ?? null,
        trackId: sample.trackId,
        objectLabel: track.label,
        objectConfidence: track.score,
        objectBoxX1: track.bbox.x1,
        objectBoxY1: track.bbox.y1,
        objectBoxX2: track.bbox.x2,
        objectBoxY2: track.bbox.y2,
      });
      if (activeItemRef.current === item) {
        captureFeedback.value = withSequence(
          withTiming(1, { duration: 60, reduceMotion: ReduceMotion.System }),
          withTiming(0, { duration: 260, reduceMotion: ReduceMotion.System })
        );
        traceRef.current?.mark('capture.haptic_requested', {
          imageId,
          itemIndex: item.itemIndex,
          timing: 'capture-accepted',
        });
        try {
          Presets.System.notificationSuccess();
          traceRef.current?.mark('capture.haptic_dispatched', {
            imageId,
            itemIndex: item.itemIndex,
          });
        } catch (error) {
          traceRef.current?.mark('capture.haptic_error', {
            imageId,
            itemIndex: item.itemIndex,
            message: formatError(error),
          });
        }
      }

      try {
        const itemDirectory = new Directory(
          sessionDirectory,
          `item-${item.itemIndex.toString().padStart(3, '0')}`
        );
        itemDirectory.create({ idempotent: true, intermediates: true });
        const photoFile = await photoOutput.capturePhotoToFile(
          { enableShutterSound: false, flashMode: 'off' },
          {
            onPreviewImageAvailable: (image) => {
              previewImage = image;
              const pendingPreviewFile = new File(itemDirectory, `${imageId}-preview.jpg`);
              previewFile = pendingPreviewFile;
              previewSavePromise = image
                .saveToFileAsync(fileUriToPath(pendingPreviewFile.uri), 'jpg', 80)
                .catch((error) => {
                  if (pendingPreviewFile.exists) pendingPreviewFile.delete();
                  if (previewFile === pendingPreviewFile) previewFile = undefined;
                  traceRef.current?.mark('capture.auto_preview_save_error', {
                    imageId,
                    itemIndex: item.itemIndex,
                    message: formatError(error),
                  });
                });
              traceRef.current?.mark('capture.auto_preview_available', {
                imageId,
                itemIndex: item.itemIndex,
                latencyMs: performance.now() - requestAt,
                itemClosed: item.finalized,
              });
            },
          }
        );
        const temporaryFile = new File(
          photoFile.filePath.startsWith('file://') ? photoFile.filePath : `file://${photoFile.filePath}`
        );
        persistedFile = new File(itemDirectory, `${imageId}.jpg`);
        await temporaryFile.move(persistedFile);
        await previewSavePromise;

        const retained: RetainedCapture = {
          fileUri: persistedFile.uri,
          id: imageId,
          previewImage: item.finalized ? undefined : previewImage,
          previewUri: previewFile?.uri,
          qualityScore: sample.qualityScore,
          signature: sample.signature,
        };
        const nextCaptures = [...item.captures];
        let replacedCapture: RetainedCapture | undefined;
        if (replaceCaptureId) {
          const replacedIndex = nextCaptures.findIndex((capture) => capture.id === replaceCaptureId);
          if (replacedIndex >= 0) {
            [replacedCapture] = nextCaptures.splice(replacedIndex, 1);
          }
        }
        nextCaptures.push(retained);
        nextCaptures.sort((left, right) => right.qualityScore - left.qualityScore);
        replaceItemCaptures(item, nextCaptures);
        if (replacedCapture) {
          try {
            const replacedFile = new File(replacedCapture.fileUri);
            if (replacedFile.exists) replacedFile.delete();
            if (replacedCapture.previewUri) {
              const replacedPreview = new File(replacedCapture.previewUri);
              if (replacedPreview.exists) replacedPreview.delete();
            }
          } catch (error) {
            traceRef.current?.mark('capture.replaced_file_cleanup_error', {
              imageId: replacedCapture.id,
              message: formatError(error),
            });
          }
        }
        if (activeItemRef.current === item) {
          selectedCapturesRef.current = item.captures;
          setSelectedCaptures(item.captures);
          state$.captureStatus.set(
            `${nextCaptures.length}/3 selected · quality ${(sample.qualityScore * 100).toFixed(0)}%`
          );
          state$.qualityGateStatus.set('Captured — move to another angle');
        }
        traceRef.current?.mark('capture.auto_saved', {
          imageId,
          cameraPosition: state$.cameraPosition.peek(),
          itemIndex: item.itemIndex,
          latencyMs: performance.now() - requestAt,
          qualityScore: sample.qualityScore,
          trackId: sample.trackId,
          objectLabel: track.label,
          objectConfidence: track.score,
          selectedCaptures: nextCaptures.length,
          selectedCaptureIds: nextCaptures.map((capture) => capture.id).join(','),
          itemClosed: item.finalized,
          needsReview: item.needsReview,
        });
      } catch (error) {
        await previewSavePromise;
        if (persistedFile?.exists) persistedFile.delete();
        if (previewFile?.exists) previewFile.delete();
        const message = formatError(error);
        state$.errorMessage.set(`Automatic capture: ${message}`);
        traceRef.current?.mark('capture.auto_error', {
          imageId,
          itemIndex: item.itemIndex,
          message,
        });
      } finally {
        captureInFlightRef.current = false;
        state$.isCapturing.set(false);
      }
    },
    [
      activeItemRef,
      captureFeedback,
      captureInFlightRef,
      isCameraSwitching,
      photoOutput,
      sessionState,
      state$,
      traceRef,
    ]
  );

  const requestAutoCapture = useCallback((
    sample: FrameQualitySample,
    track: ObjectTrack,
    replaceCaptureId?: string
  ) => {
    const capturePromise = captureAutoCandidate(sample, track, replaceCaptureId);
    activeCapturePromiseRef.current = capturePromise;
    void capturePromise.finally(() => {
      if (activeCapturePromiseRef.current === capturePromise) {
        activeCapturePromiseRef.current = null;
      }
    });
  }, [captureAutoCandidate]);

  const nextItem = useCallback(() => {
    if (sessionState !== 'running' || stopRequestedRef.current) return;

    const pressedAt = performance.now();
    const previousItem = activeItemRef.current;
    const pendingCapture = activeCapturePromiseRef.current;
    traceRef.current?.mark('item.next_pressed', {
      itemIndex: previousItem.itemIndex,
      captureInFlight: captureInFlightRef.current,
    });
    const completedItem = finalizeCurrentItem();
    void (async () => {
      await pendingCapture;
      await identifyItem(completedItem);
    })();
    const nextIndex = previousItem.itemIndex + 1;
    resetCurrentItem(nextIndex);
    state$.currentItemIndex.set(nextIndex);
    traceRef.current?.mark('item.started', {
      itemIndex: nextIndex,
      previousItemIndex: previousItem.itemIndex,
      acknowledgementLatencyMs: performance.now() - pressedAt,
    });
    Presets.System.selection();
  }, [
    activeItemRef,
    captureInFlightRef,
    finalizeCurrentItem,
    identifyItem,
    resetCurrentItem,
    sessionState,
    state$,
    traceRef,
  ]);

  const requestStop = useCallback(() => {
    if (stopRequestedRef.current) return false;
    stopRequestedRef.current = true;
    return true;
  }, []);

  const waitForPendingCapture = useCallback(
    async () => activeCapturePromiseRef.current,
    []
  );

  return {
    activeCapturePromiseRef,
    completedItemsRef,
    finalizeCurrentItem,
    initialize,
    nextItem,
    requestAutoCapture,
    requestStop,
    resetForSession,
    selectedCaptures,
    selectedCapturesRef,
    sessionDirectoryRef,
    stopRequestedRef,
    waitForPendingCapture,
  };
}
