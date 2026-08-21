import { useObservable, useValue } from '@legendapp/state/react';
import type { IdentifyResponse } from '@snap/protocol';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Image } from 'react-native-nitro-image';
import { Presets } from 'react-native-pulsar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  Camera,
  type CameraOrientation,
  CommonResolutions,
  type Frame,
  type ScannedObject,
  useFrameOutput,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import {
  type Barcode,
  type TargetBarcodeFormat,
  useBarcodeScanner,
} from 'react-native-vision-camera-barcode-scanner';
import { scheduleOnRN } from 'react-native-worklets';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type { AudioStatsEvent } from '../../../modules/snap-native/src/SnapNative.types';
import {
  identifyItemImages,
} from '../backend/backend-client';
import {
  analysisFrameId,
  shouldAnalyzeFrame,
} from '../slice-one/analysis-profile';
import {
  LABEL_AGNOSTIC_PROPOSAL_POLICY,
  evaluateInventoryCaptureProposal,
  evaluateLabelAgnosticProposal,
  resolveObjectDetectionFrameSize,
} from '../slice-one/label-agnostic-proposal';
import {
  captureQualityFailure,
  evaluateCapture,
  INITIAL_CAPTURE_POLICY_STATE,
  type CapturePolicyState,
  type FrameQualitySample,
  type SelectedCapture,
} from '../slice-one/capture-policy';
import { createStoredZip, type ZipEntry } from '../slice-one/diagnostic-bundle';
import {
  createCaptureItem,
  finalizeCaptureItem,
  replaceItemCaptures,
  type CaptureItem,
} from '../slice-one/item-session';
import { computeScanGuideLayout } from '../slice-one/scan-guide-layout';
import {
  INITIAL_OBJECT_TRACKER_STATE,
  type DetectionCandidate,
  type ObjectTrack,
  type ObjectTrackerState,
  updateObjectTracker,
} from '../slice-one/object-tracker';
import { analyzeBgraPixels } from '../slice-one/rgb-quality';
import {
  resolveSalientObjectShadow,
  selectCaptureTrack,
  type SalientObjectObservation,
} from '../slice-one/salient-object-shadow';
import { summarizeCaptureLifecycle } from '../slice-one/session-summary';
import {
  SliceOneControlsPanel,
  SliceOneScanGuide,
  SliceOneStatusPanel,
} from './slice-one-view';
import {
  createInitialSliceOneViewState,
  EMPTY_METRICS,
  type Metrics,
} from './slice-one-view-state';
import { percentile, SliceTrace } from './trace';
import {
  SALIENT_OBJECT_TYPE,
  useSliceOneCamera,
} from './use-slice-one-camera';
import { useSliceOneControlStream } from './use-slice-one-control-stream';
import { useSliceOneExecuTorch } from './use-slice-one-executorch';

// VisionCamera Worklets 5.2.2 can accept an async task without executing its
// callback, retaining the Frame indefinitely. Keep quality analysis on the
// frame-output thread so ownership always ends in the same callback.
const AUDIO_STATS_UI_STRIDE = 10;
const CAMERA_FPS = 30;
const FRAME_TIMESTAMP_SECONDS_SCALE = Platform.OS === 'android' ? 1 / 1_000_000_000 : 1;
const SOAK_TARGET_MS = 10 * 60 * 1_000;
const BARCODE_FORMATS: TargetBarcodeFormat[] = ['ean-13', 'upc-a', 'qr-code', 'code-128'];
const IDENTIFICATION_IMAGE_LIMIT = 2;
const QUALITY_FRAME_SIZE = 64;
const SIGNATURE_GRID_SIZE = 8;

type CaptureGateOutcome =
  | 'busy'
  | 'capture'
  | 'cooldown'
  | 'duplicate'
  | 'no-object'
  | 'quality'
  | 'stabilizing';

type AnalysisSample = {
  frameId: number;
  frameProcessingStartedAtMs: number;
  requested: number;
  accepted: number;
  rejected: number;
  durationMs: number;
  detections: DetectionCandidate[];
  frameHeight: number;
  frameOrientation: CameraOrientation;
  frameWidth: number;
  resizedWidth: number;
  resizedHeight: number;
  barcodeValue?: string;
  barcodeFormat?: string;
  barcodeScanned: boolean;
  brightness: number;
  clippedRatio: number;
  motion: number;
  qualityScore: number;
  sharpness: number;
  signature: number[];
};

type RetainedCapture = SelectedCapture & {
  fileUri: string;
  previewImage?: Image;
  previewUri?: string;
};

type SessionItem = CaptureItem<RetainedCapture>;

type LabelAgnosticShadowCounters = {
  acceptedFrames: number;
  filteredDetectionFrames: number;
  personDetectionFrames: number;
  recoveredTrackFrames: number;
  trackedFrames: number;
  wouldCapture: number;
};

type SalientObjectShadowCounters = {
  callbackCount: number;
  freshFrames: number;
  missingFrames: number;
  objectCount: number;
  recoveredTrackFrames: number;
  staleFrames: number;
  trackedFrames: number;
  wouldCapture: number;
};

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyCaptureGateCounts(): Record<CaptureGateOutcome, number> {
  return {
    busy: 0,
    capture: 0,
    cooldown: 0,
    duplicate: 0,
    'no-object': 0,
    quality: 0,
    stabilizing: 0,
  };
}

function emptyLabelAgnosticShadowCounters(): LabelAgnosticShadowCounters {
  return {
    acceptedFrames: 0,
    filteredDetectionFrames: 0,
    personDetectionFrames: 0,
    recoveredTrackFrames: 0,
    trackedFrames: 0,
    wouldCapture: 0,
  };
}

function emptySalientObjectShadowCounters(): SalientObjectShadowCounters {
  return {
    callbackCount: 0,
    freshFrames: 0,
    missingFrames: 0,
    objectCount: 0,
    recoveredTrackFrames: 0,
    staleFrames: 0,
    trackedFrames: 0,
    wouldCapture: 0,
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileUriToPath(uri: string) {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function formatIdentityCandidate(candidate: IdentifyResponse['candidate']) {
  const parts = [
    candidate.brand,
    candidate.productName,
    candidate.model,
    candidate.variant,
  ];
  const uniqueParts = parts.filter(
    (part, index): part is string =>
      Boolean(part) &&
      parts.findIndex(
        (candidate) => candidate?.toLocaleLowerCase() === part?.toLocaleLowerCase()
      ) === index
  );
  return uniqueParts.length > 0 ? uniqueParts.join(' ') : candidate.category;
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
  const setAudioStats = viewState$.audioStats.set;
  const setTelemetry = viewState$.telemetry.set;
  const setCaptureStatus = viewState$.captureStatus.set;
  const setModelResult = viewState$.modelResult.set;
  const setModelProbeRequested = viewState$.modelProbeRequested.set;
  const setExportUri = viewState$.exportUri.set;
  const setErrorMessage = viewState$.errorMessage.set;
  const setCurrentItemIndex = viewState$.currentItemIndex.set;
  const setQualityGateStatus = viewState$.qualityGateStatus.set;
  const setIsCapturing = viewState$.isCapturing.set;
  const setAnalysisTargetFps = viewState$.analysisTargetFps.set;
  const setIdentificationStatus = viewState$.identificationStatus.set;
  const microphonePermission = useMicrophonePermission();
  const barcodeScanner = useBarcodeScanner({ barcodeFormats: BARCODE_FORMATS });

  const [latestImage, setLatestImage] = useState<Image | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [topPanelBottom, setTopPanelBottom] = useState(0);
  const [bottomPanelTop, setBottomPanelTop] = useState(0);
  const [selectedCaptures, setSelectedCaptures] = useState<RetainedCapture[]>([]);

  const traceRef = useRef<SliceTrace | null>(null);
  const audioStatsRef = useRef<AudioStatsEvent | null>(null);
  const droppedFramesRef = useRef(0);
  const frameDurationsRef = useRef<number[]>([]);
  const frameGateEventsRef = useRef(0);
  const captureGateCountsRef = useRef(emptyCaptureGateCounts());
  const analysisClockRef = useRef({ atMs: 0, inputFrames: 0, accepted: 0 });
  const firstAnalysisFrameIdRef = useRef<number | null>(null);
  const captureInFlightRef = useRef(false);
  const activeCapturePromiseRef = useRef<Promise<void> | null>(null);
  const stopRequestedRef = useRef(false);
  const capturePolicyRef = useRef<CapturePolicyState>(INITIAL_CAPTURE_POLICY_STATE);
  const selectedCapturesRef = useRef<RetainedCapture[]>([]);
  const labelAgnosticCapturePolicyRef = useRef<CapturePolicyState>(
    INITIAL_CAPTURE_POLICY_STATE
  );
  const labelAgnosticSelectedCapturesRef = useRef<SelectedCapture[]>([]);
  const labelAgnosticShadowCountersRef = useRef(emptyLabelAgnosticShadowCounters());
  const labelAgnosticTrackerRef = useRef<ObjectTrackerState>(INITIAL_OBJECT_TRACKER_STATE);
  const salientObjectCapturePolicyRef = useRef<CapturePolicyState>(
    INITIAL_CAPTURE_POLICY_STATE
  );
  const salientObjectObservationRef = useRef<SalientObjectObservation | null>(null);
  const salientObjectSelectedCapturesRef = useRef<SelectedCapture[]>([]);
  const salientObjectShadowCountersRef = useRef(emptySalientObjectShadowCounters());
  const salientObjectTrackerRef = useRef<ObjectTrackerState>(INITIAL_OBJECT_TRACKER_STATE);
  const activeItemRef = useRef<SessionItem>(createCaptureItem<RetainedCapture>(1));
  const completedItemsRef = useRef<SessionItem[]>([]);
  const identificationRequestedItemsRef = useRef(new Set<string>());
  const objectTrackerRef = useRef<ObjectTrackerState>(INITIAL_OBJECT_TRACKER_STATE);
  const sessionDirectoryRef = useRef<Directory | null>(null);
  const autoCaptureRef = useRef<
    ((sample: FrameQualitySample, track: ObjectTrack, replaceCaptureId?: string) => Promise<void>) | null
  >(null);

  const analysisRequested = useSharedValue(0);
  const analysisAccepted = useSharedValue(0);
  const analysisRejected = useSharedValue(0);
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
  const resetCameraTracking = useCallback(() => {
    capturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    objectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    labelAgnosticCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    labelAgnosticTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    salientObjectCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    salientObjectObservationRef.current = null;
    salientObjectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    previousFrameSignature.value = [];
  }, [previousFrameSignature]);
  const onSalientObjectsScanned = useCallback((objects: ScannedObject[]) => {
    const salientObjects = objects.filter((object) => object.type === SALIENT_OBJECT_TYPE);
    salientObjectObservationRef.current = {
      boxes: salientObjects.map((object) => ({
        height: object.boundingBox.height,
        width: object.boundingBox.width,
        x: object.boundingBox.x,
        y: object.boundingBox.y,
      })),
      receivedAtMs: performance.now(),
    };
    const counters = salientObjectShadowCountersRef.current;
    counters.callbackCount += 1;
    counters.objectCount += salientObjects.length;
  }, []);
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

  const replaceLatestImage = useCallback((image: Image) => {
    setLatestImage(image);
  }, []);

  const onAnalysisSample = useCallback((sample: AnalysisSample) => {
    const now = performance.now();
    handleAnalysisFrame(sample.frameProcessingStartedAtMs);
    firstAnalysisFrameIdRef.current ??= sample.frameId;
    const inputFrames = Math.max(
      viewState$.metrics.inputFrames.peek(),
      sample.frameId - firstAnalysisFrameIdRef.current + 1
    );
    const detectionFrameSize = resolveObjectDetectionFrameSize(
      sample.frameWidth,
      sample.frameHeight
    );
    const captureProposal = evaluateInventoryCaptureProposal(
      sample.detections,
      detectionFrameSize.width,
      detectionFrameSize.height
    );
    const trackingResult = updateObjectTracker(
      objectTrackerRef.current,
      captureProposal.outcome === 'accepted' ? [captureProposal.candidate] : [],
      detectionFrameSize.width,
      detectionFrameSize.height
    );
    objectTrackerRef.current = trackingResult.state;
    const visibleTrack = trackingResult.visibleTrack;
    const labelAgnosticProposal = evaluateLabelAgnosticProposal(
      sample.detections,
      detectionFrameSize.width,
      detectionFrameSize.height
    );
    const labelAgnosticTrackingResult = updateObjectTracker(
      labelAgnosticTrackerRef.current,
      labelAgnosticProposal.outcome === 'accepted'
        ? [{ ...labelAgnosticProposal.candidate, label: 'foreground-proposal' }]
        : [],
      detectionFrameSize.width,
      detectionFrameSize.height
    );
    labelAgnosticTrackerRef.current = labelAgnosticTrackingResult.state;
    const labelAgnosticTrack = labelAgnosticTrackingResult.visibleTrack;
    const salientObjectShadow = resolveSalientObjectShadow(
      salientObjectObservationRef.current,
      now,
      sample.frameWidth,
      sample.frameHeight
    );
    const salientObjectProposal = evaluateLabelAgnosticProposal(
      salientObjectShadow.detections,
      sample.frameWidth,
      sample.frameHeight
    );
    const salientObjectTrackingResult = updateObjectTracker(
      salientObjectTrackerRef.current,
      salientObjectProposal.outcome === 'accepted' ? [salientObjectProposal.candidate] : [],
      sample.frameWidth,
      sample.frameHeight
    );
    salientObjectTrackerRef.current = salientObjectTrackingResult.state;
    const salientObjectTrack = salientObjectTrackingResult.visibleTrack;
    const captureTrackSelection = selectCaptureTrack(visibleTrack, salientObjectTrack);
    const captureTrack = captureTrackSelection.track;
    const previous = analysisClockRef.current;
    const elapsed = previous.atMs > 0 ? now - previous.atMs : 0;
    const previewFps =
      elapsed > 0 ? ((inputFrames - previous.inputFrames) * 1_000) / elapsed : 0;
    const analysisFps =
      elapsed > 0 ? ((sample.accepted - previous.accepted) * 1_000) / elapsed : 0;

    analysisClockRef.current = {
      atMs: now,
      inputFrames,
      accepted: sample.accepted,
    };
    frameDurationsRef.current.push(sample.durationMs);
    if (frameDurationsRef.current.length > 600) frameDurationsRef.current.shift();
    frameGateEventsRef.current += 1;

    const nextMetrics: Metrics = {
      ...viewState$.metrics.peek(),
      inputFrames,
      previewFps,
      analysisRequested: sample.requested,
      analysisAccepted: sample.accepted,
      analysisRejected: sample.rejected,
      analysisFps,
      droppedFrames: viewState$.metrics.droppedFrames.peek(),
      detectionCount: sample.detections.length,
      gateP50Ms: percentile(frameDurationsRef.current, 0.5),
      gateP95Ms: percentile(frameDurationsRef.current, 0.95),
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      barcodeScans:
        viewState$.metrics.barcodeScans.peek() + (sample.barcodeScanned ? 1 : 0),
      lastBarcode: sample.barcodeValue
        ? `${sample.barcodeFormat ?? 'unknown'} ${sample.barcodeValue}`
        : viewState$.metrics.lastBarcode.peek(),
      objectConfidence: captureTrack?.score ?? 0,
      objectLabel: captureTrack?.label ?? 'none',
      resizeResult:
        sample.resizedWidth > 0 ? `${sample.resizedWidth}×${sample.resizedHeight}` : 'unavailable',
      trackId: captureTrack?.id ?? 'none',
    };
    setMetrics(nextMetrics);

    const qualitySample: FrameQualitySample = {
      atMs: now,
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      signature: sample.signature,
      trackId: captureTrack?.id ?? null,
    };
    const labelAgnosticQualitySample: FrameQualitySample = {
      ...qualitySample,
      trackId: labelAgnosticTrack?.id ?? null,
    };
    const salientObjectQualitySample: FrameQualitySample = {
      ...qualitySample,
      trackId: salientObjectTrack?.id ?? null,
    };
    const labelAgnosticResult = evaluateCapture(
      labelAgnosticCapturePolicyRef.current,
      labelAgnosticQualitySample,
      labelAgnosticSelectedCapturesRef.current,
      isCameraSwitching()
    );
    labelAgnosticCapturePolicyRef.current = labelAgnosticResult.state;
    const labelAgnosticCaptureOutcome: CaptureGateOutcome =
      labelAgnosticResult.decision.action === 'capture'
        ? 'capture'
        : labelAgnosticResult.decision.reason;
    let labelAgnosticReplaceCaptureId: string | undefined;
    if (labelAgnosticResult.decision.action === 'capture') {
      const nextSelected = [...labelAgnosticSelectedCapturesRef.current];
      const { replaceCaptureId } = labelAgnosticResult.decision;
      labelAgnosticReplaceCaptureId = replaceCaptureId;
      if (replaceCaptureId) {
        const replacementIndex = nextSelected.findIndex(
          (capture) => capture.id === replaceCaptureId
        );
        if (replacementIndex >= 0) nextSelected.splice(replacementIndex, 1);
      }
      nextSelected.push({
        id: `label-agnostic-${sample.frameId}`,
        qualityScore: sample.qualityScore,
        signature: sample.signature,
      });
      nextSelected.sort((left, right) => right.qualityScore - left.qualityScore);
      labelAgnosticSelectedCapturesRef.current = nextSelected;
    }
    const salientObjectResult = evaluateCapture(
      salientObjectCapturePolicyRef.current,
      salientObjectQualitySample,
      salientObjectSelectedCapturesRef.current,
      isCameraSwitching()
    );
    salientObjectCapturePolicyRef.current = salientObjectResult.state;
    const salientObjectCaptureOutcome: CaptureGateOutcome =
      salientObjectResult.decision.action === 'capture'
        ? 'capture'
        : salientObjectResult.decision.reason;
    let salientObjectReplaceCaptureId: string | undefined;
    if (salientObjectResult.decision.action === 'capture') {
      const nextSelected = [...salientObjectSelectedCapturesRef.current];
      const { replaceCaptureId } = salientObjectResult.decision;
      salientObjectReplaceCaptureId = replaceCaptureId;
      if (replaceCaptureId) {
        const replacementIndex = nextSelected.findIndex(
          (capture) => capture.id === replaceCaptureId
        );
        if (replacementIndex >= 0) nextSelected.splice(replacementIndex, 1);
      }
      nextSelected.push({
        id: `salient-object-${sample.frameId}`,
        qualityScore: sample.qualityScore,
        signature: sample.signature,
      });
      nextSelected.sort((left, right) => right.qualityScore - left.qualityScore);
      salientObjectSelectedCapturesRef.current = nextSelected;
    }

    const labelAgnosticCounters = labelAgnosticShadowCountersRef.current;
    if (sample.detections.some((detection) => detection.label === 'person')) {
      labelAgnosticCounters.personDetectionFrames += 1;
    }
    if (sample.detections.length > 0 && !visibleTrack) {
      labelAgnosticCounters.filteredDetectionFrames += 1;
    }
    if (labelAgnosticProposal.outcome === 'accepted') {
      labelAgnosticCounters.acceptedFrames += 1;
    }
    if (labelAgnosticTrack) {
      labelAgnosticCounters.trackedFrames += 1;
      if (!visibleTrack) labelAgnosticCounters.recoveredTrackFrames += 1;
    }
    if (labelAgnosticResult.decision.action === 'capture') {
      labelAgnosticCounters.wouldCapture += 1;
    }
    const salientObjectCounters = salientObjectShadowCountersRef.current;
    if (salientObjectShadow.freshness === 'fresh') {
      salientObjectCounters.freshFrames += 1;
    } else if (salientObjectShadow.freshness === 'missing') {
      salientObjectCounters.missingFrames += 1;
    } else if (salientObjectShadow.freshness === 'stale') {
      salientObjectCounters.staleFrames += 1;
    }
    if (salientObjectTrack) {
      salientObjectCounters.trackedFrames += 1;
      if (!visibleTrack) salientObjectCounters.recoveredTrackFrames += 1;
    }
    if (salientObjectResult.decision.action === 'capture') {
      salientObjectCounters.wouldCapture += 1;
    }
    const result = evaluateCapture(
      capturePolicyRef.current,
      qualitySample,
      selectedCapturesRef.current,
      captureInFlightRef.current || isCameraSwitching() || stopRequestedRef.current
    );
    capturePolicyRef.current = result.state;
    const gateOutcome: CaptureGateOutcome =
      result.decision.action === 'capture' ? 'capture' : result.decision.reason;
    captureGateCountsRef.current[gateOutcome] += 1;
    const gateDetail =
      gateOutcome === 'quality' ? captureQualityFailure(qualitySample) : gateOutcome;

    traceRef.current?.mark('vision.frame_gate', {
      frameId: sample.frameId,
      cameraPosition: viewState$.cameraPosition.peek(),
      inputFrames,
      analysisRequested: sample.requested,
      analysisAccepted: sample.accepted,
      analysisRejected: sample.rejected,
      durationMs: sample.durationMs,
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      frameWidth: sample.frameWidth,
      frameHeight: sample.frameHeight,
      frameOrientation: sample.frameOrientation,
      detectionFrameWidth: detectionFrameSize.width,
      detectionFrameHeight: detectionFrameSize.height,
      barcodeScanned: sample.barcodeScanned,
      barcode: sample.barcodeValue,
      detectionCount: sample.detections.length,
      detectionCandidates: sample.detections
        .map(
          (detection) =>
            `${detection.label}:${detection.score.toFixed(3)}:` +
            `${detection.bbox.x1.toFixed(1)},${detection.bbox.y1.toFixed(1)},` +
            `${detection.bbox.x2.toFixed(1)},${detection.bbox.y2.toFixed(1)}`
        )
        .join('|'),
      objectLabel: captureTrack?.label,
      objectConfidence: captureTrack?.score,
      trackId: captureTrack?.id,
      captureTrackSource: captureTrackSelection.source,
      captureProposalOutcome: captureProposal.outcome,
      captureProposalLabel: captureProposal.candidate?.label,
      captureProposalScore: captureProposal.candidate?.score,
      captureGateOutcome: gateOutcome,
      captureGateDetail: gateDetail,
      labelAgnosticProposalOutcome: labelAgnosticProposal.outcome,
      labelAgnosticProposalLabel: labelAgnosticProposal.candidate?.label,
      labelAgnosticProposalScore: labelAgnosticProposal.candidate?.score,
      labelAgnosticProposalX1: labelAgnosticProposal.candidate?.bbox.x1,
      labelAgnosticProposalY1: labelAgnosticProposal.candidate?.bbox.y1,
      labelAgnosticProposalX2: labelAgnosticProposal.candidate?.bbox.x2,
      labelAgnosticProposalY2: labelAgnosticProposal.candidate?.bbox.y2,
      labelAgnosticTrackId: labelAgnosticTrack?.id,
      labelAgnosticRecoveredTrack: Boolean(labelAgnosticTrack && !visibleTrack),
      labelAgnosticCaptureOutcome,
      labelAgnosticWouldCapture: labelAgnosticResult.decision.action === 'capture',
      labelAgnosticItemIndex: activeItemRef.current.itemIndex,
      labelAgnosticReplaceCaptureId,
      labelAgnosticSelectedCaptureCount:
        labelAgnosticSelectedCapturesRef.current.length,
      labelAgnosticSelectedCaptureIds: labelAgnosticSelectedCapturesRef.current
        .map((capture) => capture.id)
        .join(','),
      salientObjectFreshness: salientObjectShadow.freshness,
      salientObjectAgeMs: salientObjectShadow.ageMs ?? undefined,
      salientObjectDetectionCount: salientObjectShadow.detections.length,
      salientObjectDetections: salientObjectShadow.detections
        .map(
          (detection) =>
            `${detection.bbox.x1.toFixed(1)},${detection.bbox.y1.toFixed(1)},` +
            `${detection.bbox.x2.toFixed(1)},${detection.bbox.y2.toFixed(1)}`
        )
        .join('|'),
      salientObjectProposalOutcome: salientObjectProposal.outcome,
      salientObjectProposalX1: salientObjectProposal.candidate?.bbox.x1,
      salientObjectProposalY1: salientObjectProposal.candidate?.bbox.y1,
      salientObjectProposalX2: salientObjectProposal.candidate?.bbox.x2,
      salientObjectProposalY2: salientObjectProposal.candidate?.bbox.y2,
      salientObjectTrackId: salientObjectTrack?.id,
      salientObjectRecoveredTrack: Boolean(salientObjectTrack && !visibleTrack),
      salientObjectCaptureOutcome,
      salientObjectWouldCapture: salientObjectResult.decision.action === 'capture',
      salientObjectItemIndex: activeItemRef.current.itemIndex,
      salientObjectReplaceCaptureId,
      salientObjectSelectedCaptureCount: salientObjectSelectedCapturesRef.current.length,
      salientObjectSelectedCaptureIds: salientObjectSelectedCapturesRef.current
        .map((capture) => capture.id)
        .join(','),
    });

    if (result.decision.action === 'capture' && captureTrack) {
      setQualityGateStatus('Stable view selected');
      const capturePromise = autoCaptureRef.current?.(
        qualitySample,
        captureTrack,
        result.decision.replaceCaptureId
      );
      if (capturePromise) {
        activeCapturePromiseRef.current = capturePromise;
        void capturePromise.finally(() => {
          if (activeCapturePromiseRef.current === capturePromise) {
            activeCapturePromiseRef.current = null;
          }
        });
      }
    } else if (result.decision.action === 'hold') {
      const labels = {
        busy: 'Saving selected photo',
        cooldown: 'Move to another angle',
        duplicate: 'View is too similar',
        'no-object': detectorReady ? 'Center one object' : 'Preparing object detector',
        quality: 'Hold steady in even light',
        stabilizing: 'Stable — keep holding',
      } as const;
      setQualityGateStatus(labels[result.decision.reason]);
    } else {
      traceRef.current?.mark('capture.gate_invariant_error', {
        reason: 'capture-without-visible-track',
      });
    }
  }, [detectorReady, handleAnalysisFrame, isCameraSwitching]);

  const onAnalysisError = useCallback((message: string) => {
    setErrorMessage(`Frame processor: ${message}`);
    traceRef.current?.mark('vision.frame_gate.error', { message });
  }, []);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const frameId = analysisFrameId(
        frame.timestamp,
        CAMERA_FPS,
        FRAME_TIMESTAMP_SECONDS_SCALE
      );

      if (
        !shouldAnalyzeFrame(
          frame.timestamp,
          analysisTargetFps,
          CAMERA_FPS,
          FRAME_TIMESTAMP_SECONDS_SCALE
        )
      ) {
        frame.dispose();
        return;
      }

      analysisRequested.value += 1;
      const requested = analysisRequested.value;
      const startedAt = performance.now();
      let barcodes: Barcode[] = [];
      let detections: DetectionCandidate[] = [];
      try {
        detections = detectObjects(frame);
        if (
          frame.pixelFormat !== 'rgb-bgra-8-bit' ||
          frame.isPlanar ||
          !frame.hasPixelBuffer
        ) {
          throw new Error(`Unsupported RGB frame format: ${frame.pixelFormat}`);
        }
        const quality = analyzeBgraPixels(
          new Uint8Array(frame.getPixelBuffer()),
          frame.width,
          frame.height,
          frame.bytesPerRow,
          QUALITY_FRAME_SIZE,
          SIGNATURE_GRID_SIZE
        );
        const signature = quality.signature;

        const previousSignature = previousFrameSignature.value;
        let motion = Number.POSITIVE_INFINITY;
        if (previousSignature.length === signature.length) {
          let signatureDifference = 0;
          for (let index = 0; index < signature.length; index += 1) {
            signatureDifference += Math.abs(signature[index] - previousSignature[index]);
          }
          motion = signatureDifference / signature.length;
        }
        previousFrameSignature.value = signature;

        const brightness = quality.brightness;
        const clippedRatio = quality.clippedRatio;
        const sharpness = quality.sharpness;
        const exposureScore = Math.max(0, 1 - Math.abs(brightness - 130) / 130);
        const clippingScore = Math.max(0, 1 - clippedRatio / 0.3);
        const motionScore = Number.isFinite(motion) ? Math.max(0, 1 - motion / 24) : 0;
        const sharpnessScore = Math.min(1, sharpness / 30);
        const qualityScore =
          exposureScore * 0.25 + clippingScore * 0.15 + motionScore * 0.25 + sharpnessScore * 0.35;

        barcodes = barcodeScanner.scanCodes(frame);
        const firstBarcode = barcodes[0];
        const barcodeValue = firstBarcode?.rawValue ?? firstBarcode?.displayValue;
        const barcodeFormat = firstBarcode?.format;

        analysisAccepted.value += 1;
        scheduleOnRN(onAnalysisSample, {
          frameId,
          frameProcessingStartedAtMs: startedAt,
          requested,
          accepted: analysisAccepted.value,
          rejected: analysisRejected.value,
          durationMs: performance.now() - startedAt,
          detections,
          frameHeight: frame.height,
          frameOrientation: frame.orientation,
          frameWidth: frame.width,
          resizedWidth: QUALITY_FRAME_SIZE,
          resizedHeight: QUALITY_FRAME_SIZE,
          barcodeValue,
          barcodeFormat,
          barcodeScanned: barcodes.length > 0,
          brightness,
          clippedRatio,
          motion,
          qualityScore,
          sharpness,
          signature,
        });
      } catch (error) {
        analysisRejected.value += 1;
        scheduleOnRN(onAnalysisError, String(error));
      } finally {
        for (const barcode of barcodes) barcode.dispose();
        frame.dispose();
      }
    },
    [
      analysisAccepted,
      analysisRejected,
      analysisRequested,
      analysisTargetFps,
      barcodeScanner,
      detectObjects,
      onAnalysisError,
      onAnalysisSample,
      previousFrameSignature,
    ]
  );

  const onFrameDropped = useCallback((reason: string) => {
    droppedFramesRef.current += 1;
    const droppedFrames = droppedFramesRef.current;
    if (droppedFrames !== 1 && droppedFrames % 10 !== 0) return;

    const nextMetrics = {
      ...viewState$.metrics.peek(),
      droppedFrames,
    };
    setMetrics(nextMetrics);
    traceRef.current?.mark('vision.frame_dropped', { reason, droppedFrames });
  }, []);

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_16_9,
    pixelFormat: 'rgb',
    dropFramesWhileBusy: true,
    onFrame,
    onFrameDropped,
  });

  const cameraOutputs = useMemo(
    () =>
      salientObjectOutput
        ? [photoOutput, frameOutput, salientObjectOutput]
        : [photoOutput, frameOutput],
    [frameOutput, photoOutput, salientObjectOutput]
  );
  const cameraConstraints = useMemo(
    () => [{ fps: CAMERA_FPS }, { resolutionBias: frameOutput }],
    [frameOutput]
  );

  useEffect(() => {
    return () => {
      closeControlStream();
      selectedCapturesRef.current = [];
      void SnapNative?.stopPcmCapture();
    };
  }, [closeControlStream]);

  useEffect(() => {
    if (!SnapNative) return;

    const statsSubscription = SnapNative.addListener('onAudioStats', (event) => {
      audioStatsRef.current = event;
      if (event.chunkIndex === 1 || event.chunkIndex % AUDIO_STATS_UI_STRIDE === 0) {
        setAudioStats(event);
        traceRef.current?.mark('speech.pcm_chunk', {
          chunkIndex: event.chunkIndex,
          frames: event.frames,
          rms: event.rms,
          startupLatencyMs: event.startupLatencyMs || undefined,
        });
      }
    });
    const errorSubscription = SnapNative.addListener('onAudioError', (event) => {
      setErrorMessage(`Audio capture: ${event.message}`);
      traceRef.current?.mark('speech.capture.error', { message: event.message });
    });

    return () => {
      statsSubscription.remove();
      errorSubscription.remove();
    };
  }, []);

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

  useEffect(() => {
    if (sessionState !== 'running' || !SnapNative) return;
    const nativeModule = SnapNative;

    const poll = () => {
      const nextTelemetry = nativeModule.getTelemetry();
      setTelemetry(nextTelemetry);
      traceRef.current?.mark('telemetry.sample', {
        thermalState: nextTelemetry.thermalState,
        residentMemoryBytes: nextTelemetry.residentMemoryBytes,
      });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => clearInterval(timer);
  }, [sessionState]);

  const resetSessionMetrics = useCallback(() => {
    const reset = { ...EMPTY_METRICS };
    droppedFramesRef.current = 0;
    setMetrics(reset);
    setAudioStats(null);
    audioStatsRef.current = null;
    setTelemetry(null);
    setElapsedMs(0);
    viewState$.sessionStartedAt.set(null);
    viewState$.sessionEndedAt.set(null);
    frameDurationsRef.current = [];
    frameGateEventsRef.current = 0;
    captureGateCountsRef.current = emptyCaptureGateCounts();
    labelAgnosticShadowCountersRef.current = emptyLabelAgnosticShadowCounters();
    salientObjectShadowCountersRef.current = emptySalientObjectShadowCounters();
    analysisClockRef.current = { atMs: 0, inputFrames: 0, accepted: 0 };
    firstAnalysisFrameIdRef.current = null;
    analysisRequested.value = 0;
    analysisAccepted.value = 0;
    analysisRejected.value = 0;
    previousFrameSignature.value = [];
    capturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    objectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    labelAgnosticCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    labelAgnosticSelectedCapturesRef.current = [];
    labelAgnosticTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    salientObjectCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    salientObjectObservationRef.current = null;
    salientObjectSelectedCapturesRef.current = [];
    salientObjectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    captureInFlightRef.current = false;
    stopRequestedRef.current = false;
    setIsCapturing(false);
    resetCameraForSession();
    setExportUri(null);
    identificationRequestedItemsRef.current.clear();
    setIdentificationStatus('Identity API waiting for a completed item');
  }, [
    analysisAccepted,
    analysisRejected,
    analysisRequested,
    previousFrameSignature,
    resetCameraForSession,
  ]);

  const resetCurrentItem = useCallback((itemIndex: number) => {
    const item = createCaptureItem<RetainedCapture>(itemIndex);
    activeItemRef.current = item;
    selectedCapturesRef.current = item.captures;
    setSelectedCaptures([]);
    capturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    objectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    labelAgnosticCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    labelAgnosticSelectedCapturesRef.current = [];
    labelAgnosticTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    salientObjectCapturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    salientObjectObservationRef.current = null;
    salientObjectSelectedCapturesRef.current = [];
    salientObjectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    previousFrameSignature.value = [];
    setQualityGateStatus('Waiting for a stable view');
    setCaptureStatus('No photos selected for this item');
    return item;
  }, [previousFrameSignature]);

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
      labelAgnosticSelectedCaptures: labelAgnosticSelectedCapturesRef.current.length,
      labelAgnosticSelectedCaptureIds: labelAgnosticSelectedCapturesRef.current
        .map((capture) => capture.id)
        .join(','),
      salientObjectSelectedCaptures: salientObjectSelectedCapturesRef.current.length,
      salientObjectSelectedCaptureIds: salientObjectSelectedCapturesRef.current
        .map((capture) => capture.id)
        .join(','),
    });
    return item;
  }, []);

  const identifyCompletedItem = useCallback(async (item: SessionItem) => {
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
    if (identificationRequestedItemsRef.current.has(requestKey)) return;
    identificationRequestedItemsRef.current.add(requestKey);

    setIdentificationStatus(`Item ${item.itemIndex} · identifying with Groq…`);
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
          setIdentificationStatus(
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
      setIdentificationStatus(
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
      setIdentificationStatus(`Item ${item.itemIndex} · identity failed: ${message}`);
      trace.mark('identity.error', {
        imageId: primaryCapture.id,
        itemIndex: item.itemIndex,
        message,
      });
    }
  }, []);

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
      resetCurrentItem(1);
      completedItemsRef.current = [];
      setCurrentItemIndex(1);
      const sessionDirectory = new Directory(Paths.document, 'slice-one', sessionId);
      sessionDirectory.create({ idempotent: true, intermediates: true });
      sessionDirectoryRef.current = sessionDirectory;
      trace.mark('item.started', { itemIndex: 1 });

      const startedAt = performance.now();
      setSessionStartedAt(startedAt);
      setSessionState('running');
      void connectControlStream(sessionId, trace);

      if (!SnapNative) {
        trace.mark('speech.capture.unavailable');
        setErrorMessage('SnapNative is not linked; raw PCM capture is unavailable.');
        return;
      }

      const audioSpan = trace.beginSpan('speech.microphone_start');
      const nativeAudioSpan = SnapNative.beginSpan('speech.microphone_start', sessionId);
      try {
        const audioStart = await SnapNative.startPcmCapture(80);
        trace.endSpan(audioSpan, {
          sampleRate: audioStart.sampleRate,
          chunkDurationMs: audioStart.chunkDurationMs,
        });
        SnapNative.endSpan(nativeAudioSpan, 'speech.microphone_start', 'ready');
      } catch (error) {
        const message = formatError(error);
        trace.endSpan(audioSpan, { error: message });
        SnapNative.endSpan(nativeAudioSpan, 'speech.microphone_start', message);
        setErrorMessage(`Raw PCM capture failed: ${message}`);
      }
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
    resetCurrentItem,
    resetSessionMetrics,
    salientObjectOutput,
    sessionState,
  ]);

  const exportTrace = useCallback(() => {
    const trace = traceRef.current;
    if (!trace) return null;

    const currentSessionStartedAt = viewState$.sessionStartedAt.peek();
    const durationMs = currentSessionStartedAt !== null
      ? (viewState$.sessionEndedAt.peek() ?? performance.now()) - currentSessionStartedAt
      : viewState$.elapsedMs.peek();
    const currentMetrics = viewState$.metrics.peek();
    const currentTelemetry = SnapNative?.getTelemetry() ?? viewState$.telemetry.peek();
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
        cameraPosition: viewState$.cameraPosition.peek(),
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
    setExportUri(uri);
    return uri;
  }, [
    analysisTargetFps,
    cameraDevice,
    classificationError,
    classificationReady,
    detectorError,
    detectorModelName,
    detectorReady,
    detectorThreshold,
    executorchAvailable,
    salientObjectOutput,
  ]);

  const shareTrace = useCallback(async () => {
    try {
      setErrorMessage(null);
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
      const bundleFile = new File(
        Paths.document,
        `slice-1-${trace.sessionId}-diagnostic.zip`
      );
      bundleFile.create({ overwrite: true });
      bundleFile.write(createStoredZip(entries));
      setExportUri(bundleFile.uri);

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
      setErrorMessage(`Trace sharing: ${message}`);
      Alert.alert('Unable to share trace', message);
    }
  }, [exportTrace]);

  const stopSession = useCallback(async () => {
    if (sessionState !== 'running' || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
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
    await activeCapturePromiseRef.current;

    try {
      const audioStop = await SnapNative?.stopPcmCapture();
      traceRef.current?.mark('speech.microphone_stopped', {
        chunks: audioStop?.chunks,
        durationMs: audioStop?.durationMs,
      });
    } catch (error) {
      traceRef.current?.mark('speech.stop.error', { message: formatError(error) });
    }

    const completedItem = finalizeCurrentItem();
    void identifyCompletedItem(completedItem);
    setSessionState('idle');
    exportTrace();
  }, [exportTrace, finalizeCurrentItem, identifyCompletedItem, sessionState]);

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
      setIsCapturing(true);
      const imageId = makeSessionId();
      const requestAt = performance.now();
      let previewImage: Image | undefined;
      let persistedFile: File | undefined;
      let previewFile: File | undefined;
      let previewSavePromise: Promise<void> | undefined;
      traceRef.current?.mark('capture.auto_requested', {
        imageId,
        cameraPosition: viewState$.cameraPosition.peek(),
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
          setCaptureStatus(
            `${nextCaptures.length}/3 selected · quality ${(sample.qualityScore * 100).toFixed(0)}%`
          );
          setQualityGateStatus('Captured — move to another angle');
        }
        traceRef.current?.mark('capture.auto_saved', {
          imageId,
          cameraPosition: viewState$.cameraPosition.peek(),
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
        setErrorMessage(`Automatic capture: ${message}`);
        traceRef.current?.mark('capture.auto_error', {
          imageId,
          itemIndex: item.itemIndex,
          message,
        });
      } finally {
        captureInFlightRef.current = false;
        setIsCapturing(false);
      }
    },
    [captureFeedback, isCameraSwitching, photoOutput, sessionState]
  );
  autoCaptureRef.current = captureAutoCandidate;

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
      await identifyCompletedItem(completedItem);
    })();
    const nextIndex = previousItem.itemIndex + 1;
    resetCurrentItem(nextIndex);
    setCurrentItemIndex(nextIndex);
    traceRef.current?.mark('item.started', {
      itemIndex: nextIndex,
      previousItemIndex: previousItem.itemIndex,
      acknowledgementLatencyMs: performance.now() - pressedAt,
    });
    Presets.System.selection();
  }, [finalizeCurrentItem, identifyCompletedItem, resetCurrentItem, sessionState]);

  const captureAndProbe = useCallback(async () => {
    if (sessionState !== 'running' || captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    setIsCapturing(true);
    setModelProbeRequested(true);

    const imageId = makeSessionId();
    const requestAt = performance.now();
    const trace = traceRef.current;
    trace?.mark('capture.requested', { imageId });
    let nativePhotoSpan = SnapNative?.beginSpan('capture.photo', imageId);
    setCaptureStatus('Capturing in memory…');
    setErrorMessage(null);

    let photo;
    let temporaryPath: string | null = null;
    try {
      photo = await photoOutput.capturePhoto(
        { flashMode: 'off', enableShutterSound: true },
        {
          onPreviewImageAvailable: (previewImage) => {
            replaceLatestImage(previewImage);
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
      replaceLatestImage(image);
      setCaptureStatus(`${photo.width}×${photo.height} in-memory photo`);
      if (nativePhotoSpan) {
        SnapNative?.endSpan(nativePhotoSpan, 'capture.photo', `${photo.width}x${photo.height}`);
        nativePhotoSpan = undefined;
      }

      if (!classificationReady) {
        setModelResult(
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
      setErrorMessage(`Photo/model probe: ${message}`);
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
      setIsCapturing(false);
    }
  }, [
    classificationDownloadProgress,
    classificationError,
    classificationReady,
    photoOutput,
    replaceLatestImage,
    runClassification,
    sessionState,
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
  }, [captureAndProbe]);

  const onPreviewLayout = useCallback((event: LayoutChangeEvent) => {
    setPreviewSize(event.nativeEvent.layout);
  }, []);

  const onTopPanelLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, y } = event.nativeEvent.layout;
    setTopPanelBottom(y + height);
  }, []);

  const onBottomPanelLayout = useCallback((event: LayoutChangeEvent) => {
    setBottomPanelTop(event.nativeEvent.layout.y);
  }, []);

  const scanGuide = computeScanGuideLayout({
    bottomPanelTop,
    previewHeight: previewSize.height,
    previewWidth: previewSize.width,
    topPanelBottom,
  });

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
