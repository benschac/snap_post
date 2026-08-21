import type { Observable } from '@legendapp/state';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { File, Paths, type Directory } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, type RefObject } from 'react';
import { Alert } from 'react-native';
import type {
  CameraDevice,
  CameraObjectOutput,
} from 'react-native-vision-camera';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type { AudioStatsEvent } from '../../../modules/snap-native/src/SnapNative.types';
import { createStoredZip, type ZipEntry } from '../slice-one/diagnostic-bundle';
import { summarizeCaptureLifecycle } from '../slice-one/session-summary';
import { formatError } from './format-error';
import type { SliceOneViewState } from './slice-one-view-state';
import type {
  CaptureGateOutcome,
  LabelAgnosticShadowCounters,
  SalientObjectShadowCounters,
  SessionItem,
} from './slice-one-types';
import type { SliceTrace } from './trace';

const SOAK_TARGET_MS = 10 * 60 * 1_000;

type UseSliceOneDiagnosticsOptions = {
  activeItemRef: RefObject<SessionItem>;
  analysisTargetFps: number;
  audioStatsRef: RefObject<AudioStatsEvent | null>;
  cameraDevice: CameraDevice | undefined;
  captureGateCountsRef: RefObject<Record<CaptureGateOutcome, number>>;
  classificationError: string | null;
  classificationReady: boolean;
  completedItemsRef: RefObject<SessionItem[]>;
  detectorError: string | null;
  detectorModelName: string;
  detectorReady: boolean;
  detectorThreshold: number;
  droppedFramesRef: RefObject<number>;
  executorchAvailable: boolean;
  frameGateEventsRef: RefObject<number>;
  labelAgnosticShadowCountersRef: RefObject<LabelAgnosticShadowCounters>;
  salientObjectOutput: CameraObjectOutput | null;
  salientObjectShadowCountersRef: RefObject<SalientObjectShadowCounters>;
  sessionDirectoryRef: RefObject<Directory | null>;
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneDiagnostics({
  activeItemRef,
  analysisTargetFps,
  audioStatsRef,
  cameraDevice,
  captureGateCountsRef,
  classificationError,
  classificationReady,
  completedItemsRef,
  detectorError,
  detectorModelName,
  detectorReady,
  detectorThreshold,
  droppedFramesRef,
  executorchAvailable,
  frameGateEventsRef,
  labelAgnosticShadowCountersRef,
  salientObjectOutput,
  salientObjectShadowCountersRef,
  sessionDirectoryRef,
  state$,
  traceRef,
}: UseSliceOneDiagnosticsOptions) {
  const exportTrace = useCallback(() => {
    const trace = traceRef.current;
    if (!trace) return null;

    const currentSessionStartedAt = state$.sessionStartedAt.peek();
    const durationMs = currentSessionStartedAt !== null
      ? (state$.sessionEndedAt.peek() ?? performance.now()) - currentSessionStartedAt
      : state$.elapsedMs.peek();
    const currentMetrics = state$.metrics.peek();
    const currentTelemetry = SnapNative?.getTelemetry() ?? state$.telemetry.peek();
    const captureSummary = summarizeCaptureLifecycle(
      completedItemsRef.current.map((item) => item.captures.length),
      activeItemRef.current.captures.length,
      activeItemRef.current.finalized
    );
    const uri = trace.export({
      device: {
        modelName: Device.modelName ?? 'unknown',
        osName: Device.osName ?? 'unknown',
        osVersion: Device.osVersion ?? 'unknown',
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        executorchAvailable,
      },
      summary: {
        durationMs,
        soakTargetMet: durationMs >= SOAK_TARGET_MS,
        analysisTargetFps,
        frameGateEvents: frameGateEventsRef.current,
        measuredAnalysisFps:
          durationMs > 0 ? frameGateEventsRef.current / (durationMs / 1_000) : 0,
        inputFrames: currentMetrics.inputFrames,
        analysisRequested: currentMetrics.analysisRequested,
        analysisAccepted: currentMetrics.analysisAccepted,
        analysisRejected: currentMetrics.analysisRejected,
        droppedFrames: droppedFramesRef.current,
        barcodeScans: currentMetrics.barcodeScans,
        resizeResult: currentMetrics.resizeResult,
        gateP50Ms: currentMetrics.gateP50Ms,
        gateP95Ms: currentMetrics.gateP95Ms,
        captureGateCaptures: captureGateCountsRef.current.capture,
        captureGateBusy: captureGateCountsRef.current.busy,
        captureGateCooldown: captureGateCountsRef.current.cooldown,
        captureGateDuplicates: captureGateCountsRef.current.duplicate,
        captureGateNoObject: captureGateCountsRef.current['no-object'],
        captureGateQuality: captureGateCountsRef.current.quality,
        captureGateStabilizing: captureGateCountsRef.current.stabilizing,
        labelAgnosticAcceptedFrames:
          labelAgnosticShadowCountersRef.current.acceptedFrames,
        labelAgnosticFilteredDetectionFrames:
          labelAgnosticShadowCountersRef.current.filteredDetectionFrames,
        labelAgnosticPersonDetectionFrames:
          labelAgnosticShadowCountersRef.current.personDetectionFrames,
        labelAgnosticRecoveredTrackFrames:
          labelAgnosticShadowCountersRef.current.recoveredTrackFrames,
        labelAgnosticTrackedFrames: labelAgnosticShadowCountersRef.current.trackedFrames,
        labelAgnosticWouldCapture: labelAgnosticShadowCountersRef.current.wouldCapture,
        salientObjectCallbackCount:
          salientObjectShadowCountersRef.current.callbackCount,
        salientObjectCount: salientObjectShadowCountersRef.current.objectCount,
        salientObjectFreshFrames: salientObjectShadowCountersRef.current.freshFrames,
        salientObjectMissingFrames: salientObjectShadowCountersRef.current.missingFrames,
        salientObjectStaleFrames: salientObjectShadowCountersRef.current.staleFrames,
        salientObjectRecoveredTrackFrames:
          salientObjectShadowCountersRef.current.recoveredTrackFrames,
        salientObjectTrackedFrames: salientObjectShadowCountersRef.current.trackedFrames,
        salientObjectWouldCapture: salientObjectShadowCountersRef.current.wouldCapture,
        salientObjectShadowMode: false,
        salientObjectFallbackEnabled: true,
        salientObjectOutputAttached: salientObjectOutput !== null,
        salientObjectOutputWidth: salientObjectOutput?.currentResolution?.width ?? null,
        salientObjectOutputHeight: salientObjectOutput?.currentResolution?.height ?? null,
        cameraPosition: state$.cameraPosition.peek(),
        cameraDeviceId: cameraDevice?.id ?? null,
        cameraDeviceName: cameraDevice?.name ?? null,
        completedItems: captureSummary.completedItems,
        reviewItems: completedItemsRef.current.filter((item) => item.needsReview).length,
        activeSelectedPhotos: captureSummary.activeSelectedPhotos,
        selectedPhotos: captureSummary.selectedPhotos,
        captureDirectory: sessionDirectoryRef.current?.uri ?? null,
        audioChunks: audioStatsRef.current?.chunkIndex ?? 0,
        thermalState: currentTelemetry?.thermalState ?? 'unknown',
        residentMemoryBytes: currentTelemetry?.residentMemoryBytes ?? 0,
        detectorModel: detectorModelName,
        detectorReady,
        detectorError,
        detectorThreshold,
        labelAgnosticShadowMode: true,
        lastTrackId: currentMetrics.trackId,
        lastObjectLabel: currentMetrics.objectLabel,
        modelReady: classificationReady,
        modelError: classificationError,
      },
    });
    state$.exportUri.set(uri);
    return uri;
  }, [
    activeItemRef,
    analysisTargetFps,
    audioStatsRef,
    cameraDevice,
    captureGateCountsRef,
    classificationError,
    classificationReady,
    completedItemsRef,
    detectorError,
    detectorModelName,
    detectorReady,
    detectorThreshold,
    droppedFramesRef,
    executorchAvailable,
    frameGateEventsRef,
    labelAgnosticShadowCountersRef,
    salientObjectOutput,
    salientObjectShadowCountersRef,
    sessionDirectoryRef,
    state$,
    traceRef,
  ]);

  const shareTrace = useCallback(async () => {
    try {
      state$.errorMessage.set(null);
      const uri = exportTrace();
      if (!uri) throw new Error('Start a session before sharing its trace.');

      const traceFile = new File(uri);
      if (!traceFile.exists) throw new Error(`The trace file was not created at ${uri}`);
      const trace = traceRef.current;
      if (!trace) throw new Error('The active trace is unavailable.');

      const items = [...completedItemsRef.current];
      if (!activeItemRef.current.finalized) items.push(activeItemRef.current);
      const entries: ZipEntry[] = [{ name: 'trace.json', bytes: await traceFile.bytes() }];
      for (const item of items) {
        for (const capture of item.captures) {
          if (!capture.previewUri) continue;
          const previewFile = new File(capture.previewUri);
          if (!previewFile.exists) continue;
          entries.push({
            name: `previews/item-${item.itemIndex.toString().padStart(3, '0')}/${capture.id}.jpg`,
            bytes: await previewFile.bytes(),
          });
        }
      }
      const bundleFile = new File(Paths.document, `slice-1-${trace.sessionId}-diagnostic.zip`);
      bundleFile.create({ overwrite: true });
      bundleFile.write(createStoredZip(entries));
      state$.exportUri.set(bundleFile.uri);

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error(
          'Native sharing is unavailable in this build. Rebuild and reinstall the development client.'
        );
      }
      await Sharing.shareAsync(bundleFile.uri, {
        UTI: 'public.zip-archive',
        mimeType: 'application/zip',
      });
    } catch (error) {
      const message = formatError(error);
      state$.errorMessage.set(`Trace sharing: ${message}`);
      Alert.alert('Unable to share trace', message);
    }
  }, [activeItemRef, completedItemsRef, exportTrace, state$, traceRef]);

  return { exportTrace, shareTrace };
}
