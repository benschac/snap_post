import type { Observable } from '@legendapp/state';
import { File } from 'expo-file-system';
import { useCallback, useState, type RefObject } from 'react';
import type { Image } from 'react-native-nitro-image';
import type { CameraPhotoOutput } from 'react-native-vision-camera';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import { formatError } from './format-error';
import type { SliceOneViewState } from './slice-one-view-state';
import type { SliceTrace } from './trace';

type UseSliceOneDevProbeOptions = {
  activeCapturePromiseRef: RefObject<Promise<void> | null>;
  captureInFlightRef: RefObject<boolean>;
  classificationDownloadProgress: number;
  classificationError: string | null;
  classificationReady: boolean;
  photoOutput: CameraPhotoOutput;
  runClassification: (fileUri: string, imageId: string) => Promise<void>;
  sessionState: SliceOneViewState['sessionState'];
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

function makeImageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useSliceOneDevProbe({
  activeCapturePromiseRef,
  captureInFlightRef,
  classificationDownloadProgress,
  classificationError,
  classificationReady,
  photoOutput,
  runClassification,
  sessionState,
  state$,
  traceRef,
}: UseSliceOneDevProbeOptions) {
  const [latestImage, setLatestImage] = useState<Image | null>(null);

  const captureAndProbe = useCallback(async () => {
    if (sessionState !== 'running' || captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    state$.isCapturing.set(true);
    state$.modelProbeRequested.set(true);

    const imageId = makeImageId();
    const requestAt = performance.now();
    const trace = traceRef.current;
    trace?.mark('capture.requested', { imageId });
    let nativePhotoSpan = SnapNative?.beginSpan('capture.photo', imageId);
    state$.captureStatus.set('Capturing in memory…');
    state$.errorMessage.set(null);

    let photo;
    let temporaryPath: string | null = null;
    try {
      photo = await photoOutput.capturePhoto(
        { flashMode: 'off', enableShutterSound: true },
        {
          onPreviewImageAvailable: (previewImage) => {
            setLatestImage(previewImage);
            trace?.mark('capture.preview_available', {
              imageId,
              latencyMs: performance.now() - requestAt,
            });
          },
        }
      );
      trace?.mark('capture.photo_ready', {
        imageId,
        latencyMs: performance.now() - requestAt,
        width: photo.width,
        height: photo.height,
      });

      const image = await photo.toImageAsync();
      setLatestImage(image);
      state$.captureStatus.set(`${photo.width}×${photo.height} in-memory photo`);
      if (nativePhotoSpan) {
        SnapNative?.endSpan(nativePhotoSpan, 'capture.photo', `${photo.width}x${photo.height}`);
        nativePhotoSpan = undefined;
      }

      if (!classificationReady) {
        state$.modelResult.set(
          classificationError
            ? `Heuristic fallback: ${classificationError}`
            : `Model downloading ${(classificationDownloadProgress * 100).toFixed(0)}%`
        );
        return;
      }

      temporaryPath = await photo.saveToTemporaryFileAsync();
      await runClassification(
        temporaryPath.startsWith('file://') ? temporaryPath : `file://${temporaryPath}`,
        imageId
      );
    } catch (error) {
      const message = formatError(error);
      state$.errorMessage.set(`Photo/model probe: ${message}`);
      trace?.mark('capture_or_inference.error', { imageId, message });
      if (nativePhotoSpan) SnapNative?.endSpan(nativePhotoSpan, 'capture.photo', message);
    } finally {
      photo?.dispose();
      if (temporaryPath) {
        const temporaryFile = new File(
          temporaryPath.startsWith('file://') ? temporaryPath : `file://${temporaryPath}`
        );
        if (temporaryFile.exists) temporaryFile.delete();
      }
      captureInFlightRef.current = false;
      state$.isCapturing.set(false);
    }
  }, [
    captureInFlightRef,
    classificationDownloadProgress,
    classificationError,
    classificationReady,
    photoOutput,
    runClassification,
    sessionState,
    state$,
    traceRef,
  ]);

  const runDevProbe = useCallback(() => {
    if (activeCapturePromiseRef.current) return;
    const capturePromise = captureAndProbe();
    activeCapturePromiseRef.current = capturePromise;
    void capturePromise.finally(() => {
      if (activeCapturePromiseRef.current === capturePromise) {
        activeCapturePromiseRef.current = null;
      }
    });
  }, [activeCapturePromiseRef, captureAndProbe]);

  return { latestImage, runDevProbe };
}
