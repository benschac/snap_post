import { useObservable, useValue } from '@legendapp/state/react';
import { StatusBar } from 'expo-status-bar';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import {
  Camera,
  type ScannedObject,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import {
  type TargetBarcodeFormat,
  useBarcodeScanner,
} from 'react-native-vision-camera-barcode-scanner';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import { LABEL_AGNOSTIC_PROPOSAL_POLICY } from '../slice-one/label-agnostic-proposal';
import { createCaptureItem } from '../slice-one/item-session';
import {
  SliceOneControlsPanel,
  SliceOneScanGuide,
  SliceOneStatusPanel,
} from './slice-one-view';
import {
  createInitialSliceOneViewState,
  EMPTY_METRICS,
} from './slice-one-view-state';
import type { RetainedCapture, SessionItem } from './slice-one-types';
import { SliceTrace } from './trace';
import { formatError } from './format-error';
import { useScanGuideLayout } from './use-scan-guide-layout';
import { useSliceOneAnalysisPolicy } from './use-slice-one-analysis-policy';
import { useSliceOneAudioTelemetry } from './use-slice-one-audio-telemetry';
import {
  SALIENT_OBJECT_TYPE,
  useSliceOneCamera,
} from './use-slice-one-camera';
import { useSliceOneCaptureSession } from './use-slice-one-capture-session';
import { useSliceOneControlStream } from './use-slice-one-control-stream';
import { useSliceOneExecuTorch } from './use-slice-one-executorch';
import { useSliceOneDiagnostics } from './use-slice-one-diagnostics';
import { useSliceOneDevProbe } from './use-slice-one-dev-probe';
import { useSliceOneFrameOutput } from './use-slice-one-frame-output';
import { useSliceOneIdentification } from './use-slice-one-identification';

// VisionCamera Worklets 5.2.2 can accept an async task without executing its
// callback, retaining the Frame indefinitely. Keep quality analysis on the
// frame-output thread so ownership always ends in the same callback.
const SOAK_TARGET_MS = 10 * 60 * 1_000;
const BARCODE_FORMATS: TargetBarcodeFormat[] = ['ean-13', 'upc-a', 'qr-code', 'code-128'];
const QUALITY_FRAME_SIZE = 64;

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function SliceOneScreen() {
  const insets = useSafeAreaInsets();
  const viewState$ = useObservable(createInitialSliceOneViewState());
  const sessionState = useValue(viewState$.sessionState);
  const modelProbeRequested = useValue(viewState$.modelProbeRequested);
  const analysisTargetFps = useValue(viewState$.analysisTargetFps);
  const setSessionState = viewState$.sessionState.set;
  const setSessionStartedAt = viewState$.sessionStartedAt.set;
  const setElapsedMs = viewState$.elapsedMs.set;
  const setMetrics = viewState$.metrics.set;
  const setModelResult = viewState$.modelResult.set;
  const setExportUri = viewState$.exportUri.set;
  const setErrorMessage = viewState$.errorMessage.set;
  const setQualityGateStatus = viewState$.qualityGateStatus.set;
  const setAnalysisTargetFps = viewState$.analysisTargetFps.set;
  const microphonePermission = useMicrophonePermission();
  const barcodeScanner = useBarcodeScanner({ barcodeFormats: BARCODE_FORMATS });

  const traceRef = useRef<SliceTrace | null>(null);
  const droppedFramesRef = useRef(0);
  const captureInFlightRef = useRef(false);
  const activeItemRef = useRef<SessionItem>(createCaptureItem<RetainedCapture>(1));
  const resetCameraTrackingRef = useRef<() => void>(() => undefined);
  const resetItemTrackingRef = useRef<() => void>(() => undefined);
  const getShadowCaptureSummaryRef = useRef(() => ({
    labelAgnosticSelectedCaptures: 0,
    labelAgnosticSelectedCaptureIds: '',
    salientObjectSelectedCaptures: 0,
    salientObjectSelectedCaptureIds: '',
  }));
  const onSalientObjectsScannedRef = useRef<(objects: ScannedObject[]) => void>(
    () => undefined
  );

  const previousFrameSignature = useSharedValue<number[]>([]);
  const captureFeedback = useSharedValue(0);

  const {
    classificationDownloadProgress,
    classificationError,
    classificationReady,
    detectorDownloadProgress,
    detectorError,
    detectorModelName,
    detectorReady,
    detectorThreshold,
    detectObjects,
    executorchAvailable,
    runClassification,
  } = useSliceOneExecuTorch({
    modelProbeRequested,
    setErrorMessage,
    setModelResult,
    traceRef,
  });
  const resetCameraTracking = useCallback(() => resetCameraTrackingRef.current(), []);
  const resetItemTracking = useCallback(() => resetItemTrackingRef.current(), []);
  const getShadowCaptureSummary = useCallback(
    () => getShadowCaptureSummaryRef.current(),
    []
  );
  const onSalientObjectsScanned = useCallback(
    (objects: ScannedObject[]) => onSalientObjectsScannedRef.current(objects),
    []
  );
  const getCurrentItemIndex = useCallback(() => activeItemRef.current.itemIndex, []);
  const {
    cameraDevice,
    cameraPermission,
    cameraPosition,
    flipCamera,
    handleAnalysisFrame,
    isActive: isCameraActive,
    isSwitching: isCameraSwitching,
    nextCameraAvailable,
    nextCameraPosition,
    onConfigured: onCameraConfigured,
    onError: onCameraError,
    onInterruptionEnded: onCameraInterruptionEnded,
    onInterruptionStarted: onCameraInterruptionStarted,
    onPreviewStarted: onCameraPreviewStarted,
    photoOutput,
    resetForSession: resetCameraForSession,
    salientObjectOutput,
  } = useSliceOneCamera({
    captureInFlightRef,
    getCurrentItemIndex,
    onCameraTrackingReset: resetCameraTracking,
    onSalientObjectsScanned,
    state$: viewState$,
    traceRef,
  });
  const captureFeedbackStyle = useAnimatedStyle(() => ({
    opacity: captureFeedback.value,
    transform: [{ scale: 1 + captureFeedback.value * 0.035 }],
  }));
  const {
    close: closeControlStream,
    connect: connectControlStream,
  } = useSliceOneControlStream(viewState$);
  const {
    audioStatsRef,
    reset: resetAudioTelemetry,
    start: startAudioTelemetry,
    stop: stopAudioTelemetry,
  } = useSliceOneAudioTelemetry({ sessionState, state$: viewState$, traceRef });
  const {
    identifyItem: identifyCompletedItem,
    reset: resetIdentification,
  } = useSliceOneIdentification({ state$: viewState$, traceRef });
  const {
    activeCapturePromiseRef,
    completedItemsRef,
    finalizeCurrentItem,
    initialize: initializeCaptureSession,
    nextItem,
    requestAutoCapture,
    requestStop,
    resetForSession: resetCaptureSession,
    selectedCaptures,
    selectedCapturesRef,
    sessionDirectoryRef,
    stopRequestedRef,
    waitForPendingCapture,
  } = useSliceOneCaptureSession({
    activeItemRef,
    captureFeedback,
    captureInFlightRef,
    getShadowCaptureSummary,
    identifyItem: identifyCompletedItem,
    isCameraSwitching,
    onItemReset: resetItemTracking,
    photoOutput,
    sessionState,
    state$: viewState$,
    traceRef,
  });
  const { latestImage, runDevProbe } = useSliceOneDevProbe({
    activeCapturePromiseRef,
    captureInFlightRef,
    classificationDownloadProgress,
    classificationError,
    classificationReady,
    photoOutput,
    runClassification,
    sessionState,
    state$: viewState$,
    traceRef,
  });
  const {
    captureGateCountsRef,
    frameGateEventsRef,
    getShadowCaptureSummary: getAnalysisShadowCaptureSummary,
    labelAgnosticShadowCountersRef,
    onAnalysisSample,
    onSalientObjectsScanned: handleSalientObjectsScanned,
    resetCameraTracking: resetAnalysisCameraTracking,
    resetForSession: resetAnalysisForSession,
    resetItemTracking: resetAnalysisItemTracking,
    salientObjectShadowCountersRef,
  } = useSliceOneAnalysisPolicy({
    activeItemRef,
    captureInFlightRef,
    detectorReady,
    handleAnalysisFrame,
    isCameraSwitching,
    previousFrameSignature,
    requestAutoCapture,
    selectedCapturesRef,
    state$: viewState$,
    stopRequestedRef,
    traceRef,
  });
  useLayoutEffect(() => {
    resetCameraTrackingRef.current = resetAnalysisCameraTracking;
    resetItemTrackingRef.current = resetAnalysisItemTracking;
    getShadowCaptureSummaryRef.current = getAnalysisShadowCaptureSummary;
    onSalientObjectsScannedRef.current = handleSalientObjectsScanned;
  }, [
    getAnalysisShadowCaptureSummary,
    handleSalientObjectsScanned,
    resetAnalysisCameraTracking,
    resetAnalysisItemTracking,
  ]);
  const {
    onBottomPanelLayout,
    onPreviewLayout,
    onTopPanelLayout,
    previewSize,
    scanGuide,
  } = useScanGuideLayout();

  const {
    frameOutput,
    reset: resetFrameOutput,
  } = useSliceOneFrameOutput({
    analysisTargetFps,
    barcodeScanner,
    detectObjects,
    droppedFramesRef,
    onAnalysisSample,
    previousFrameSignature,
    state$: viewState$,
    traceRef,
  });

  const cameraOutputs = useMemo(
    () =>
      salientObjectOutput
        ? [photoOutput, frameOutput, salientObjectOutput]
        : [photoOutput, frameOutput],
    [frameOutput, photoOutput, salientObjectOutput]
  );
  const cameraConstraints = useMemo(
    () => [{ fps: 30 }, { resolutionBias: frameOutput }],
    [frameOutput]
  );
  const { exportTrace, shareTrace } = useSliceOneDiagnostics({
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
    state$: viewState$,
    traceRef,
  });

  useEffect(() => {
    return () => {
      closeControlStream();
    };
  }, [closeControlStream]);

  useEffect(() => {
    if (sessionState !== 'running') return;
    const sessionStartedAt = viewState$.sessionStartedAt.peek();
    if (sessionStartedAt === null) return;

    const update = () => {
      const nextElapsed = performance.now() - sessionStartedAt;
      setElapsedMs(nextElapsed);
    };
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [sessionState, viewState$]);

  const resetSessionMetrics = useCallback(() => {
    const reset = { ...EMPTY_METRICS };
    droppedFramesRef.current = 0;
    setMetrics(reset);
    resetAudioTelemetry();
    setElapsedMs(0);
    viewState$.sessionStartedAt.set(null);
    viewState$.sessionEndedAt.set(null);
    resetAnalysisForSession();
    resetFrameOutput();
    resetCaptureSession();
    resetCameraForSession();
    setExportUri(null);
    resetIdentification();
  }, [
    resetAnalysisForSession,
    resetAudioTelemetry,
    resetCameraForSession,
    resetCaptureSession,
    resetFrameOutput,
    resetIdentification,
  ]);

  const startSession = useCallback(async () => {
    if (sessionState !== 'idle') return;
    setSessionState('starting');
    setErrorMessage(null);
    resetSessionMetrics();

    try {
      const cameraGranted =
        cameraPermission.hasPermission || (await cameraPermission.requestPermission());
      const microphoneGranted =
        microphonePermission.hasPermission || (await microphonePermission.requestPermission());
      if (!cameraGranted || !microphoneGranted) {
        throw new Error('Camera and microphone permissions are required for Slice 1.');
      }

      const sessionId = makeSessionId();
      const trace = new SliceTrace(sessionId, 1);
      traceRef.current = trace;
      trace.mark('session.start_pressed', {
        analysisTargetFps,
        cameraPosition,
        cameraDeviceId: cameraDevice?.id ?? null,
        cameraDeviceName: cameraDevice?.name ?? null,
        detectorModel: detectorModelName,
        detectorReady,
        detectorThreshold,
        labelAgnosticShadowMode: true,
        labelAgnosticCenterRegion: '0.2,0.2,0.8,0.8',
        labelAgnosticEdgeInsetRatio: LABEL_AGNOSTIC_PROPOSAL_POLICY.edgeInsetRatio,
        labelAgnosticMaximumAreaRatio:
          LABEL_AGNOSTIC_PROPOSAL_POLICY.maximumAreaRatio,
        labelAgnosticMinimumAreaRatio:
          LABEL_AGNOSTIC_PROPOSAL_POLICY.minimumAreaRatio,
        labelAgnosticMinimumCenterOverlapRatio:
          LABEL_AGNOSTIC_PROPOSAL_POLICY.minimumCenterOverlapRatio,
        salientObjectShadowMode: false,
        salientObjectFallbackEnabled: true,
        salientObjectType: SALIENT_OBJECT_TYPE,
        salientObjectOutputAttached: salientObjectOutput !== null,
        salientObjectOutputWidth: salientObjectOutput?.currentResolution?.width ?? null,
        salientObjectOutputHeight: salientObjectOutput?.currentResolution?.height ?? null,
      });
      SnapNative?.mark('session.start_pressed', sessionId);
      initializeCaptureSession(sessionId);

      const startedAt = performance.now();
      setSessionStartedAt(startedAt);
      setSessionState('running');
      void connectControlStream(sessionId, trace);

      await startAudioTelemetry(sessionId, trace);
    } catch (error) {
      setErrorMessage(formatError(error));
      setSessionState('idle');
    }
  }, [
    analysisTargetFps,
    cameraDevice,
    cameraPosition,
    cameraPermission,
    connectControlStream,
    microphonePermission,
    detectorModelName,
    detectorReady,
    detectorThreshold,
    initializeCaptureSession,
    resetSessionMetrics,
    salientObjectOutput,
    sessionState,
    startAudioTelemetry,
  ]);

  const stopSession = useCallback(async () => {
    if (sessionState !== 'running' || !requestStop()) return;
    const endedAt = performance.now();
    viewState$.sessionEndedAt.set(endedAt);
    const startedAt = viewState$.sessionStartedAt.peek();
    if (startedAt !== null) {
      setElapsedMs(endedAt - startedAt);
    }
    traceRef.current?.mark('session.stop_pressed');
    SnapNative?.mark('session.stop_pressed');
    setSessionState('stopping');
    setQualityGateStatus('Finishing the current capture');
    await waitForPendingCapture();

    await stopAudioTelemetry();

    const completedItem = finalizeCurrentItem();
    void identifyCompletedItem(completedItem);
    setSessionState('idle');
    exportTrace();
  }, [
    exportTrace,
    finalizeCurrentItem,
    identifyCompletedItem,
    requestStop,
    sessionState,
    stopAudioTelemetry,
    waitForPendingCapture,
  ]);

  return (
    <View style={styles.container} onLayout={onPreviewLayout}>
      <StatusBar style="light" />
      {cameraDevice && cameraPermission.hasPermission ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device={cameraDevice}
          outputs={cameraOutputs}
          constraints={cameraConstraints}
          isActive={isCameraActive}
          enableNativeTapToFocusGesture
          onConfigured={onCameraConfigured}
          onPreviewStarted={onCameraPreviewStarted}
          onError={onCameraError}
          onInterruptionStarted={onCameraInterruptionStarted}
          onInterruptionEnded={onCameraInterruptionEnded}
        />
      ) : (
        <View style={styles.permissionBackdrop}>
          <Text style={styles.permissionTitle}>Slice 1 zero-tap capture</Text>
          <Text style={styles.permissionText}>
            Start requests camera and microphone access, then selects stable, useful views locally.
          </Text>
        </View>
      )}

      <SliceOneScanGuide
        previewHeight={previewSize.height}
        previewWidth={previewSize.width}
        scanGuide={scanGuide}
        state$={viewState$}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.captureFeedback, captureFeedbackStyle]}
      />

      <SliceOneStatusPanel
        detectorError={Boolean(detectorError)}
        detectorReady={detectorReady}
        latestImage={latestImage}
        onLayout={onTopPanelLayout}
        primaryPreviewImage={selectedCaptures[0]?.previewImage}
        qualityFrameSize={QUALITY_FRAME_SIZE}
        state$={viewState$}
      />
      <SliceOneControlsPanel
        bottomInset={insets.bottom}
        classificationDownloadProgress={classificationDownloadProgress}
        classificationError={Boolean(classificationError)}
        classificationReady={classificationReady}
        completedItems={completedItemsRef.current.length}
        detectorDownloadProgress={detectorDownloadProgress}
        detectorError={Boolean(detectorError)}
        detectorReady={detectorReady}
        nextCameraAvailable={nextCameraAvailable}
        nextCameraPosition={nextCameraPosition}
        onAnalysisTargetFpsChange={setAnalysisTargetFps}
        onDevProbe={runDevProbe}
        onFlipCamera={flipCamera}
        onLayout={onBottomPanelLayout}
        onNextItem={nextItem}
        onShareTrace={() => void shareTrace()}
        onStart={() => void startSession()}
        onStop={() => void stopSession()}
        selectedCaptures={selectedCaptures.length}
        soakTargetMs={SOAK_TARGET_MS}
        state$={viewState$}
        traceAvailable={traceRef.current !== null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080C13',
  },
  permissionBackdrop: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    backgroundColor: '#0D1420',
  },
  permissionTitle: {
    color: '#F4F7FB',
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionText: {
    color: '#AAB6C9',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    textAlign: 'center',
  },
  captureFeedback: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    margin: 18,
    borderRadius: 28,
    borderWidth: 5,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    backgroundColor: 'rgba(109, 245, 168, 0.12)',
  },
});
