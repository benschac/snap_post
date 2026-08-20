import { Canvas, Circle, Line, RoundedRect, vec } from '@shopify/react-native-skia';
import type { IdentifyResponse, ServerEvent } from '@snap/protocol';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NitroImage, type Image } from 'react-native-nitro-image';
import { Presets } from 'react-native-pulsar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isAvailable as isExecutorchAvailable,
  models,
  useClassification,
  useObjectDetection,
} from 'react-native-executorch';
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
  type CameraObjectOutput,
  CommonResolutions,
  type Frame,
  type ScannedObject,
  type ScannedObjectType,
  VisionCamera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  useMicrophonePermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import {
  type Barcode,
  type TargetBarcodeFormat,
  useBarcodeScanner,
} from 'react-native-vision-camera-barcode-scanner';
import { scheduleOnRN } from 'react-native-worklets';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type {
  AudioStatsEvent,
  NativeTelemetry,
} from '../../../modules/snap-native/src/SnapNative.types';
import {
  createControlClient,
  identifyItemImages,
  resolveControlSocketUrl,
} from '../backend/backend-client';
import {
  ANALYSIS_TARGET_FPS_OPTIONS,
  analysisFrameId,
  shouldAnalyzeFrame,
  type AnalysisTargetFps,
} from '../slice-one/analysis-profile';
import {
  beginCameraSwitch,
  markCameraSwitchConfigured,
  shouldCompleteCameraSwitch,
  type CameraSwitchState,
} from '../slice-one/camera-switch-lifecycle';
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
import {
  computeScanGuideLayout,
  SCAN_GUIDE_HORIZONTAL_INSET,
} from '../slice-one/scan-guide-layout';
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
import { percentile, SliceTrace } from './trace';

// VisionCamera Worklets 5.2.2 can accept an async task without executing its
// callback, retaining the Frame indefinitely. Keep quality analysis on the
// frame-output thread so ownership always ends in the same callback.
const AUDIO_STATS_UI_STRIDE = 10;
const CAMERA_FPS = 30;
const FRAME_TIMESTAMP_SECONDS_SCALE = Platform.OS === 'android' ? 1 / 1_000_000_000 : 1;
const DETECTION_THRESHOLD = 0.5;
const SOAK_TARGET_MS = 10 * 60 * 1_000;
const BARCODE_FORMATS: TargetBarcodeFormat[] = ['ean-13', 'upc-a', 'qr-code', 'code-128'];
const SALIENT_OBJECT_TYPES: ScannedObjectType[] = ['salient-object'];
const PHOTO_PREVIEW_SIZE = { width: 320, height: 320 };
const IDENTIFICATION_PHOTO_SIZE = CommonResolutions.HD_4_3;
const IDENTIFICATION_IMAGE_LIMIT = 2;
const QUALITY_FRAME_SIZE = 64;
const SIGNATURE_GRID_SIZE = 8;
const EXECUTORCH_MODEL = models.classification.efficientnet_v2_s();
const OBJECT_DETECTION_MODEL = models.object_detection.ssdlite_320_mobilenet_v3_large({
  backend: 'coreml',
});

type SessionState = 'idle' | 'starting' | 'running' | 'stopping';
type CameraPosition = 'back' | 'front';
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

type Metrics = {
  inputFrames: number;
  previewFps: number;
  analysisRequested: number;
  analysisAccepted: number;
  analysisRejected: number;
  analysisFps: number;
  droppedFrames: number;
  detectionCount: number;
  gateP50Ms: number;
  gateP95Ms: number;
  brightness: number;
  clippedRatio: number;
  motion: number;
  qualityScore: number;
  sharpness: number;
  lastBarcode: string;
  objectConfidence: number;
  objectLabel: string;
  barcodeScans: number;
  resizeResult: string;
  trackId: string;
};

const EMPTY_METRICS: Metrics = {
  inputFrames: 0,
  previewFps: 0,
  analysisRequested: 0,
  analysisAccepted: 0,
  analysisRejected: 0,
  analysisFps: 0,
  droppedFrames: 0,
  detectionCount: 0,
  gateP50Ms: 0,
  gateP95Ms: 0,
  brightness: 0,
  clippedRatio: 0,
  motion: 0,
  qualityScore: 0,
  sharpness: 0,
  lastBarcode: 'none',
  objectConfidence: 0,
  objectLabel: 'none',
  barcodeScans: 0,
  resizeResult: 'pending',
  trackId: 'none',
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

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : 'n/a';
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

function ActionButton({
  label,
  tone = 'secondary',
  disabled = false,
  onPress,
}: {
  label: string;
  tone?: 'primary' | 'danger' | 'secondary';
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'primary' && styles.actionButtonPrimary,
        tone === 'danger' && styles.actionButtonDanger,
        pressed && !disabled && styles.actionButtonPressed,
        disabled && styles.actionButtonDisabled,
      ]}>
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

function GatePill({ label, status }: { label: string; status: 'error' | 'pending' | 'ready' }) {
  return (
    <View
      style={[
        styles.gatePill,
        status === 'ready' && styles.gatePillReady,
        status === 'error' && styles.gatePillError,
      ]}>
      <View
        style={[
          styles.gateDot,
          status === 'ready' && styles.gateDotReady,
          status === 'error' && styles.gateDotError,
        ]}
      />
      <Text style={styles.gatePillText}>{label}</Text>
    </View>
  );
}

function AnalysisProfileButton({
  disabled,
  fps,
  selected,
  onPress,
}: {
  disabled: boolean;
  fps: AnalysisTargetFps;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${fps} analysis frames per second`}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.profileButton,
        selected && styles.profileButtonSelected,
        pressed && !disabled && styles.actionButtonPressed,
        disabled && styles.actionButtonDisabled,
      ]}>
      <Text style={[styles.profileButtonText, selected && styles.profileButtonTextSelected]}>
        {fps} fps
      </Text>
    </Pressable>
  );
}

export function SliceOneScreen() {
  const insets = useSafeAreaInsets();
  const [isFocused, setIsFocused] = useState(false);
  const [cameraPosition, setCameraPosition] = useState<CameraPosition>('back');
  const cameraPermission = useCameraPermission();
  const microphonePermission = useMicrophonePermission();
  const backCameraDevice = useCameraDevice('back', { physicalDevices: ['wide-angle'] });
  const frontCameraDevice = useCameraDevice('front');
  const cameraDevice = cameraPosition === 'front' ? frontCameraDevice : backCameraDevice;
  const photoOutput = usePhotoOutput({
    containerFormat: 'jpeg',
    qualityPrioritization: 'balanced',
    targetResolution: IDENTIFICATION_PHOTO_SIZE,
    previewImageTargetSize: PHOTO_PREVIEW_SIZE,
  });
  const barcodeScanner = useBarcodeScanner({ barcodeFormats: BARCODE_FORMATS });

  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [audioStats, setAudioStats] = useState<AudioStatsEvent | null>(null);
  const [telemetry, setTelemetry] = useState<NativeTelemetry | null>(null);
  const [latestImage, setLatestImage] = useState<Image | null>(null);
  const [captureStatus, setCaptureStatus] = useState('No photo captured');
  const [modelResult, setModelResult] = useState('Model probe not started');
  const [modelProbeRequested, setModelProbeRequested] = useState(false);
  const [cameraConfigured, setCameraConfigured] = useState(false);
  const [cameraPreviewStarted, setCameraPreviewStarted] = useState(false);
  const [exportUri, setExportUri] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [topPanelBottom, setTopPanelBottom] = useState(0);
  const [bottomPanelTop, setBottomPanelTop] = useState(0);
  const [currentItemIndex, setCurrentItemIndex] = useState(1);
  const [selectedCaptures, setSelectedCaptures] = useState<RetainedCapture[]>([]);
  const [qualityGateStatus, setQualityGateStatus] = useState('Waiting for a stable view');
  const [isCapturing, setIsCapturing] = useState(false);
  const [analysisTargetFps, setAnalysisTargetFps] = useState<AnalysisTargetFps>(5);
  const [identificationStatus, setIdentificationStatus] = useState(
    'Identity API waiting for a completed item'
  );

  const traceRef = useRef<SliceTrace | null>(null);
  const audioStatsRef = useRef<AudioStatsEvent | null>(null);
  const latestImageRef = useRef<Image | null>(null);
  const metricsRef = useRef(EMPTY_METRICS);
  const droppedFramesRef = useRef(0);
  const elapsedRef = useRef(0);
  const sessionStartedAtRef = useRef<number | null>(null);
  const sessionEndedAtRef = useRef<number | null>(null);
  const frameDurationsRef = useRef<number[]>([]);
  const frameGateEventsRef = useRef(0);
  const captureGateCountsRef = useRef(emptyCaptureGateCounts());
  const analysisClockRef = useRef({ atMs: 0, inputFrames: 0, accepted: 0 });
  const firstAnalysisFrameIdRef = useRef<number | null>(null);
  const firstPreviewSeenRef = useRef(false);
  const cameraPositionRef = useRef<CameraPosition>('back');
  const cameraSwitchRef = useRef<CameraSwitchState<CameraPosition> | null>(null);
  const modelReadySeenRef = useRef(false);
  const detectorReadySeenRef = useRef(false);
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
  const controlSocketRef = useRef<WebSocket | null>(null);
  const controlSubscriptionRef = useRef<AsyncIterator<ServerEvent> | null>(null);
  const controlSessionIdRef = useRef<string | null>(null);
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

  const classification = useClassification({
    model: EXECUTORCH_MODEL,
    preventLoad: !modelProbeRequested,
  });
  const objectDetection = useObjectDetection({
    model: OBJECT_DETECTION_MODEL,
  });
  const onSalientObjectsScanned = useCallback((objects: ScannedObject[]) => {
    const salientObjects = objects.filter((object) => object.type === 'salient-object');
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
  const salientObjectOutput = useMemo<CameraObjectOutput | null>(
    () =>
      Platform.OS === 'ios'
        ? VisionCamera.createObjectOutput({ enabledObjectTypes: SALIENT_OBJECT_TYPES })
        : null,
    []
  );
  useEffect(() => {
    if (!salientObjectOutput) return;
    salientObjectOutput.setOnObjectsScannedCallback(onSalientObjectsScanned);
    return () => salientObjectOutput.setOnObjectsScannedCallback(undefined);
  }, [onSalientObjectsScanned, salientObjectOutput]);
  const captureFeedbackStyle = useAnimatedStyle(() => ({
    opacity: captureFeedback.value,
    transform: [{ scale: 1 + captureFeedback.value * 0.035 }],
  }));
  const runObjectDetectionOnFrame = objectDetection.runOnFrame;

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  const closeControlStream = useCallback(() => {
    const subscription = controlSubscriptionRef.current;
    controlSubscriptionRef.current = null;
    if (subscription?.return) void subscription.return(undefined);

    const socket = controlSocketRef.current;
    controlSocketRef.current = null;
    controlSessionIdRef.current = null;
    socket?.close();
  }, []);

  const connectControlStream = useCallback(
    async (sessionId: string, trace: SliceTrace) => {
      closeControlStream();
      controlSessionIdRef.current = sessionId;
      trace.mark('control.connecting');

      try {
        const socket = new WebSocket(resolveControlSocketUrl());
        controlSocketRef.current = socket;
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
        if (controlSessionIdRef.current !== sessionId) {
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
        controlSubscriptionRef.current = events;

        for await (const event of events) {
          if (controlSessionIdRef.current !== sessionId) break;

          if (event.type === 'identity.candidate') {
            const label = formatIdentityCandidate(event.payload);
            setIdentificationStatus(
              `${event.itemIntentId} · ${label} · ${(event.payload.confidence * 100).toFixed(0)}%`
            );
            trace.mark('identity.candidate_streamed', {
              itemIntentId: event.itemIntentId,
              category: event.payload.category,
              brand: event.payload.brand,
              productName: event.payload.productName,
              confidence: event.payload.confidence,
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
            setIdentificationStatus(
              `${event.itemIntentId} · ${typeof firstTitle === 'string' ? firstTitle : `${candidateCount} web candidates`} · ${event.payload.provider?.latencyMs.toFixed(0) ?? '—'} ms`
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
            setIdentificationStatus(
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
        if (controlSessionIdRef.current !== sessionId) return;
        trace.mark('control.connection_failed', { message: formatError(error) });
        closeControlStream();
      }
    },
    [closeControlStream]
  );

  const replaceLatestImage = useCallback((image: Image) => {
    latestImageRef.current = image;
    setLatestImage(image);
  }, []);

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

  const completeCameraSwitch = useCallback(
    (signal: 'analysis-frame' | 'preview-started', deviceId: string) => {
      const pendingSwitch = cameraSwitchRef.current;
      if (!pendingSwitch || pendingSwitch.targetDeviceId !== deviceId) return false;

      cameraSwitchRef.current = null;
      resetCameraTracking();
      setCameraConfigured(true);
      setCameraPreviewStarted(true);
      setQualityGateStatus('Waiting for a stable view');
      traceRef.current?.mark('camera.flip_completed', {
        cameraPosition: pendingSwitch.targetPosition,
        cameraDeviceId: pendingSwitch.targetDeviceId,
        completionSignal: signal,
        itemIndex: activeItemRef.current.itemIndex,
        latencyMs: performance.now() - pendingSwitch.requestedAtMs,
      });
      return true;
    },
    [resetCameraTracking]
  );

  const flipCamera = useCallback(() => {
    if (
      sessionState === 'starting' ||
      sessionState === 'stopping' ||
      isCapturing ||
      captureInFlightRef.current
    ) {
      return;
    }
    const nextPosition: CameraPosition = cameraPosition === 'back' ? 'front' : 'back';
    const nextDevice = nextPosition === 'front' ? frontCameraDevice : backCameraDevice;
    if (!nextDevice) return;

    const isLiveSwitch = sessionState === 'running';
    if (isLiveSwitch) {
      traceRef.current?.mark('camera.flip_requested', {
        from: cameraPosition,
        to: nextPosition,
        itemIndex: activeItemRef.current.itemIndex,
        targetDeviceId: nextDevice.id,
      });
    }
    cameraSwitchRef.current = isLiveSwitch
      ? beginCameraSwitch(nextDevice.id, nextPosition, performance.now())
      : null;
    cameraPositionRef.current = nextPosition;
    setCameraConfigured(false);
    setCameraPreviewStarted(false);
    resetCameraTracking();
    if (sessionState === 'running') setQualityGateStatus('Switching camera');
    setCameraPosition(nextPosition);
  }, [
    backCameraDevice,
    cameraPosition,
    frontCameraDevice,
    isCapturing,
    resetCameraTracking,
    sessionState,
  ]);

  const onAnalysisSample = useCallback((sample: AnalysisSample) => {
    const now = performance.now();
    const pendingSwitch = cameraSwitchRef.current;
    if (
      shouldCompleteCameraSwitch(pendingSwitch, sample.frameProcessingStartedAtMs) &&
      pendingSwitch
    ) {
      completeCameraSwitch('analysis-frame', pendingSwitch.targetDeviceId);
    }
    firstAnalysisFrameIdRef.current ??= sample.frameId;
    const inputFrames = Math.max(
      metricsRef.current.inputFrames,
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
      ...metricsRef.current,
      inputFrames,
      previewFps,
      analysisRequested: sample.requested,
      analysisAccepted: sample.accepted,
      analysisRejected: sample.rejected,
      analysisFps,
      droppedFrames: droppedFramesRef.current,
      detectionCount: sample.detections.length,
      gateP50Ms: percentile(frameDurationsRef.current, 0.5),
      gateP95Ms: percentile(frameDurationsRef.current, 0.95),
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      barcodeScans: metricsRef.current.barcodeScans + (sample.barcodeScanned ? 1 : 0),
      lastBarcode: sample.barcodeValue
        ? `${sample.barcodeFormat ?? 'unknown'} ${sample.barcodeValue}`
        : metricsRef.current.lastBarcode,
      objectConfidence: captureTrack?.score ?? 0,
      objectLabel: captureTrack?.label ?? 'none',
      resizeResult:
        sample.resizedWidth > 0 ? `${sample.resizedWidth}×${sample.resizedHeight}` : 'unavailable',
      trackId: captureTrack?.id ?? 'none',
    };
    metricsRef.current = nextMetrics;
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
      cameraSwitchRef.current !== null
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
      cameraSwitchRef.current !== null
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
      captureInFlightRef.current || cameraSwitchRef.current !== null || stopRequestedRef.current
    );
    capturePolicyRef.current = result.state;
    const gateOutcome: CaptureGateOutcome =
      result.decision.action === 'capture' ? 'capture' : result.decision.reason;
    captureGateCountsRef.current[gateOutcome] += 1;
    const gateDetail =
      gateOutcome === 'quality' ? captureQualityFailure(qualitySample) : gateOutcome;

    traceRef.current?.mark('vision.frame_gate', {
      frameId: sample.frameId,
      cameraPosition: cameraPositionRef.current,
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
        'no-object': objectDetection.isReady ? 'Center one object' : 'Preparing object detector',
        quality: 'Hold steady in even light',
        stabilizing: 'Stable — keep holding',
      } as const;
      setQualityGateStatus(labels[result.decision.reason]);
    } else {
      traceRef.current?.mark('capture.gate_invariant_error', {
        reason: 'capture-without-visible-track',
      });
    }
  }, [completeCameraSwitch, objectDetection.isReady]);

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
        if (runObjectDetectionOnFrame) {
          detections = runObjectDetectionOnFrame(frame, false, {
            detectionThreshold: DETECTION_THRESHOLD,
          }).map((detection) => ({
            bbox: detection.bbox,
            label: String(detection.label).toLowerCase(),
            score: detection.score,
          }));
        }
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
      onAnalysisError,
      onAnalysisSample,
      previousFrameSignature,
      runObjectDetectionOnFrame,
    ]
  );

  const onFrameDropped = useCallback((reason: string) => {
    droppedFramesRef.current += 1;
    const droppedFrames = droppedFramesRef.current;
    if (droppedFrames !== 1 && droppedFrames % 10 !== 0) return;

    const nextMetrics = {
      ...metricsRef.current,
      droppedFrames,
    };
    metricsRef.current = nextMetrics;
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
  const isCameraActive =
    sessionState === 'running' && isFocused && cameraPermission.hasPermission;

  useEffect(() => {
    return () => {
      closeControlStream();
      latestImageRef.current = null;
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
    if (sessionState !== 'running' || sessionStartedAt === null) return;

    const update = () => {
      const nextElapsed = performance.now() - sessionStartedAt;
      elapsedRef.current = nextElapsed;
      setElapsedMs(nextElapsed);
    };
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [sessionStartedAt, sessionState]);

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

  useEffect(() => {
    if (classification.isReady && !modelReadySeenRef.current) {
      modelReadySeenRef.current = true;
      setModelResult('EfficientNet ready — capture to run inference');
      traceRef.current?.mark('executorch.model_ready', {
        model: EXECUTORCH_MODEL.modelName,
      });
      SnapNative?.mark('executorch.model_ready', EXECUTORCH_MODEL.modelName);
    }
  }, [classification.isReady]);

  useEffect(() => {
    if (!classification.error) return;
    const message = formatError(classification.error);
    setModelResult(`Fallback armed: ${message}`);
    traceRef.current?.mark('executorch.model_failed', { message });
  }, [classification.error]);

  useEffect(() => {
    if (!objectDetection.isReady || detectorReadySeenRef.current) return;
    detectorReadySeenRef.current = true;
    traceRef.current?.mark('object_detection.model_ready', {
      model: OBJECT_DETECTION_MODEL.modelName,
    });
    SnapNative?.mark('object_detection.model_ready', OBJECT_DETECTION_MODEL.modelName);
  }, [objectDetection.isReady]);

  useEffect(() => {
    if (!objectDetection.error) return;
    const message = formatError(objectDetection.error);
    setErrorMessage(`Object detector: ${message}`);
    traceRef.current?.mark('object_detection.model_failed', { message });
  }, [objectDetection.error]);

  const resetSessionMetrics = useCallback(() => {
    const reset = { ...EMPTY_METRICS };
    metricsRef.current = reset;
    droppedFramesRef.current = 0;
    setMetrics(reset);
    setAudioStats(null);
    audioStatsRef.current = null;
    setTelemetry(null);
    setElapsedMs(0);
    elapsedRef.current = 0;
    sessionStartedAtRef.current = null;
    sessionEndedAtRef.current = null;
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
    cameraSwitchRef.current = null;
    stopRequestedRef.current = false;
    setIsCapturing(false);
    firstPreviewSeenRef.current = false;
    setCameraPreviewStarted(false);
    setExportUri(null);
    identificationRequestedItemsRef.current.clear();
    setIdentificationStatus('Identity API waiting for a completed item');
  }, [analysisAccepted, analysisRejected, analysisRequested, previousFrameSignature]);

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
        detectorModel: OBJECT_DETECTION_MODEL.modelName,
        detectorReady: objectDetection.isReady,
        detectorThreshold: DETECTION_THRESHOLD,
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
        salientObjectType: SALIENT_OBJECT_TYPES[0],
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
      sessionStartedAtRef.current = startedAt;
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
    objectDetection.isReady,
    resetCurrentItem,
    resetSessionMetrics,
    salientObjectOutput,
    sessionState,
  ]);

  const exportTrace = useCallback(() => {
    const trace = traceRef.current;
    if (!trace) return null;

    const durationMs = sessionStartedAtRef.current !== null
      ? (sessionEndedAtRef.current ?? performance.now()) - sessionStartedAtRef.current
      : elapsedRef.current;
    const currentTelemetry = SnapNative?.getTelemetry() ?? telemetry;
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
        executorchAvailable: isExecutorchAvailable,
      },
      summary: {
        durationMs,
        soakTargetMet: durationMs >= SOAK_TARGET_MS,
        analysisTargetFps,
        frameGateEvents: frameGateEventsRef.current,
        measuredAnalysisFps:
          durationMs > 0 ? frameGateEventsRef.current / (durationMs / 1_000) : 0,
        inputFrames: metricsRef.current.inputFrames,
        analysisRequested: metricsRef.current.analysisRequested,
        analysisAccepted: metricsRef.current.analysisAccepted,
        analysisRejected: metricsRef.current.analysisRejected,
        droppedFrames: droppedFramesRef.current,
        barcodeScans: metricsRef.current.barcodeScans,
        resizeResult: metricsRef.current.resizeResult,
        gateP50Ms: metricsRef.current.gateP50Ms,
        gateP95Ms: metricsRef.current.gateP95Ms,
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
        cameraPosition: cameraPositionRef.current,
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
        detectorModel: OBJECT_DETECTION_MODEL.modelName,
        detectorReady: objectDetection.isReady,
        detectorError: objectDetection.error ? formatError(objectDetection.error) : null,
        detectorThreshold: DETECTION_THRESHOLD,
        labelAgnosticShadowMode: true,
        lastTrackId: metricsRef.current.trackId,
        lastObjectLabel: metricsRef.current.objectLabel,
        modelReady: classification.isReady,
        modelError: classification.error ? formatError(classification.error) : null,
      },
    });
    setExportUri(uri);
    return uri;
  }, [
    analysisTargetFps,
    cameraDevice,
    classification.error,
    classification.isReady,
    objectDetection.error,
    objectDetection.isReady,
    salientObjectOutput,
    telemetry,
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
    sessionEndedAtRef.current = performance.now();
    if (sessionStartedAtRef.current !== null) {
      elapsedRef.current = sessionEndedAtRef.current - sessionStartedAtRef.current;
      setElapsedMs(elapsedRef.current);
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
        cameraSwitchRef.current !== null
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
        cameraPosition: cameraPositionRef.current,
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
          cameraPosition: cameraPositionRef.current,
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
    [captureFeedback, photoOutput, sessionState]
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
    let inferenceSpan: string | undefined;
    let nativeInferenceSpan: string | undefined;
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

      if (!classification.isReady) {
        setModelResult(
          classification.error
            ? `Heuristic fallback: ${formatError(classification.error)}`
            : `Model downloading ${(classification.downloadProgress * 100).toFixed(0)}%`
        );
        return;
      }

      temporaryPath = await photo.saveToTemporaryFileAsync();
      inferenceSpan = trace?.beginSpan('executorch.inference', { imageId });
      nativeInferenceSpan = SnapNative?.beginSpan('executorch.inference', imageId);
      const result = await classification.forward(
        temporaryPath.startsWith('file://') ? temporaryPath : `file://${temporaryPath}`
      );
      const topResults = Object.entries(result as Record<string, number>)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3);
      const resultLabel = topResults
        .map(([label, confidence]) => `${label} ${(confidence * 100).toFixed(1)}%`)
        .join(' · ');
      setModelResult(resultLabel || 'Inference returned no labels');
      if (inferenceSpan) {
        trace?.endSpan(inferenceSpan, { topLabel: topResults[0]?.[0] });
        inferenceSpan = undefined;
      }
      if (nativeInferenceSpan) {
        SnapNative?.endSpan(nativeInferenceSpan, 'executorch.inference', topResults[0]?.[0]);
        nativeInferenceSpan = undefined;
      }
    } catch (error) {
      const message = formatError(error);
      setErrorMessage(`Photo/model probe: ${message}`);
      trace?.mark('capture_or_inference.error', { imageId, message });
      if (nativePhotoSpan) SnapNative?.endSpan(nativePhotoSpan, 'capture.photo', message);
      if (inferenceSpan) trace?.endSpan(inferenceSpan, { error: message });
      if (nativeInferenceSpan) {
        SnapNative?.endSpan(nativeInferenceSpan, 'executorch.inference', message);
      }
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
    classification,
    photoOutput,
    replaceLatestImage,
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
  const overlayColor =
    sessionState !== 'running' ? '#A8B1C4' : metrics.qualityScore >= 0.56 ? '#6DF5A8' : '#F6C85F';
  const soakProgress = Math.min(1, elapsedMs / SOAK_TARGET_MS);
  const nextCameraPosition: CameraPosition = cameraPosition === 'back' ? 'front' : 'back';
  const nextCameraAvailable =
    nextCameraPosition === 'front' ? frontCameraDevice !== undefined : backCameraDevice !== undefined;
  const cameraFlipDisabled =
    !nextCameraAvailable ||
    isCapturing ||
    sessionState === 'starting' ||
    sessionState === 'stopping';

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
          onConfigured={() => {
            cameraSwitchRef.current = markCameraSwitchConfigured(
              cameraSwitchRef.current,
              cameraDevice.id,
              performance.now()
            );
            setCameraConfigured(true);
            if (sessionState === 'running') {
              traceRef.current?.mark('camera.configured', {
                cameraPosition: cameraPositionRef.current,
                cameraDeviceId: cameraDevice.id,
              });
            }
          }}
          onPreviewStarted={() => {
            const completedSwitch = completeCameraSwitch('preview-started', cameraDevice.id);
            setCameraPreviewStarted(true);
            if (sessionState === 'running') {
              traceRef.current?.mark('camera.preview_started', {
                cameraPosition: cameraPositionRef.current,
                cameraDeviceId: cameraDevice.id,
                afterFlip: completedSwitch,
              });
            }
            if (!firstPreviewSeenRef.current) {
              firstPreviewSeenRef.current = true;
              traceRef.current?.mark('camera.first_preview_frame', {
                cameraPosition: cameraPositionRef.current,
                cameraDeviceId: cameraDevice.id,
              });
              SnapNative?.mark('camera.first_preview_frame');
            }
          }}
          onError={(error) => {
            setErrorMessage(`Camera: ${error.message}`);
            if (sessionState === 'running') {
              traceRef.current?.mark('camera.error', {
                message: error.message,
                cameraPosition: cameraPositionRef.current,
              });
            }
          }}
          onInterruptionStarted={(reason) => {
            traceRef.current?.mark('camera.interruption_started', { reason });
          }}
          onInterruptionEnded={() => traceRef.current?.mark('camera.interruption_ended')}
        />
      ) : (
        <View style={styles.permissionBackdrop}>
          <Text style={styles.permissionTitle}>Slice 1 zero-tap capture</Text>
          <Text style={styles.permissionText}>
            Start requests camera and microphone access, then selects stable, useful views locally.
          </Text>
        </View>
      )}

      <View pointerEvents="none" style={styles.scanGuideLayer}>
        <Canvas style={StyleSheet.absoluteFill}>
          <RoundedRect
            x={SCAN_GUIDE_HORIZONTAL_INSET}
            y={scanGuide.top}
            width={scanGuide.width}
            height={scanGuide.height}
            r={26}
            color={overlayColor}
            style="stroke"
            strokeWidth={3}
          />
          <Circle
            cx={previewSize.width / 2}
            cy={scanGuide.top + scanGuide.height / 2}
            r={4}
            color={overlayColor}
          />
          <Line
            p1={vec(previewSize.width / 2 - 22, scanGuide.top + scanGuide.height / 2)}
            p2={vec(previewSize.width / 2 + 22, scanGuide.top + scanGuide.height / 2)}
            color={overlayColor}
            strokeWidth={1}
          />
          <Line
            p1={vec(previewSize.width / 2, scanGuide.top + scanGuide.height / 2 - 22)}
            p2={vec(previewSize.width / 2, scanGuide.top + scanGuide.height / 2 + 22)}
            color={overlayColor}
            strokeWidth={1}
          />
        </Canvas>
      </View>
      <Animated.View
        pointerEvents="none"
        style={[styles.captureFeedback, captureFeedbackStyle]}
      />

      <View style={styles.topPanel} onLayout={onTopPanelLayout}>
        <View style={styles.headingRow}>
          <View>
            <Text style={styles.eyebrow}>SLICE 1 · ZERO-TAP CAPTURE</Text>
            <Text style={styles.heading}>
              {sessionState === 'running' ? `Item ${currentItemIndex} · ${qualityGateStatus}` : 'Ready to scan'}
            </Text>
          </View>
          {selectedCaptures[0]?.previewImage ? (
            <NitroImage image={selectedCaptures[0].previewImage} style={styles.thumbnail} />
          ) : latestImage ? (
            <NitroImage image={latestImage} style={styles.thumbnail} />
          ) : null}
        </View>

        <View style={styles.gateRow}>
          <GatePill
            label="Camera"
            status={cameraConfigured && cameraPreviewStarted ? 'ready' : 'pending'}
          />
          <GatePill
            label="Worklet"
            status={metrics.analysisAccepted > 0 ? 'ready' : 'pending'}
          />
          <GatePill
            label="RGB sample"
            status={
              metrics.resizeResult === `${QUALITY_FRAME_SIZE}×${QUALITY_FRAME_SIZE}`
                ? 'ready'
                : 'pending'
            }
          />
          <GatePill
            label="Quality"
            status={metrics.qualityScore >= 0.56 ? 'ready' : 'pending'}
          />
          <GatePill
            label="Barcode"
            status={metrics.barcodeScans > 0 ? 'ready' : 'pending'}
          />
          <GatePill
            label="Detector"
            status={
              objectDetection.error ? 'error' : objectDetection.isReady ? 'ready' : 'pending'
            }
          />
          <GatePill label="PCM" status={audioStats ? 'ready' : 'pending'} />
        </View>

        <View style={styles.metricsGrid}>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{(metrics.qualityScore * 100).toFixed(0)}%</Text>
            <Text style={styles.metricLabel}>quality</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.sharpness.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>sharpness</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.motion.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>motion</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.droppedFrames}</Text>
            <Text style={styles.metricLabel}>dropped</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.detectionCount}</Text>
            <Text style={styles.metricLabel}>objects</Text>
          </View>
        </View>
      </View>

      <View
        style={[styles.bottomPanel, { bottom: Math.max(10, insets.bottom + 8) }]}
        onLayout={onBottomPanelLayout}
      >
        <View style={styles.soakHeader}>
          <View>
            <Text style={styles.soakTime}>
              {formatDuration(elapsedMs)} / {formatDuration(SOAK_TARGET_MS)}
            </Text>
            <Text style={styles.soakLabel}>
              {elapsedMs >= SOAK_TARGET_MS ? 'Soak target met' : 'Physical-device soak'}
            </Text>
          </View>
          <Text style={styles.telemetryText}>
            {telemetry?.thermalState ?? 'thermal n/a'} ·{' '}
            {formatBytes(telemetry?.residentMemoryBytes ?? 0)}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${soakProgress * 100}%` }]} />
        </View>

        <Text style={styles.detailText} numberOfLines={1}>
          Brightness {metrics.brightness.toFixed(0)} · clipped {(metrics.clippedRatio * 100).toFixed(0)}%
          {' '}· gate p95 {metrics.gateP95Ms.toFixed(1)} ms
        </Text>
        <Text style={styles.detailText} numberOfLines={1}>
          Selected {selectedCaptures.length}/3 · completed items {completedItemsRef.current.length} ·{' '}
          analysis {metrics.analysisFps.toFixed(1)}/{analysisTargetFps} fps
        </Text>
        <Text style={styles.detailText} numberOfLines={1}>
          Object {metrics.objectLabel} {(metrics.objectConfidence * 100).toFixed(0)}% ·{' '}
          {metrics.trackId}
        </Text>
        <Text style={styles.detailText} numberOfLines={2}>
          {modelResult}
        </Text>
        <Text style={styles.detailText} numberOfLines={2}>
          {identificationStatus}
        </Text>
        <Text style={styles.detailText} numberOfLines={1}>
          {captureStatus} · PCM chunks {audioStats?.chunkIndex ?? 0}
        </Text>
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {exportUri ? (
          <Text selectable style={styles.exportText} numberOfLines={2}>
            Trace: {exportUri}
          </Text>
        ) : null}

        <View style={styles.profileRow}>
          <Text style={styles.profileLabel}>ANALYSIS PROFILE</Text>
          {ANALYSIS_TARGET_FPS_OPTIONS.map((fps) => (
            <AnalysisProfileButton
              key={fps}
              disabled={sessionState !== 'idle'}
              fps={fps}
              selected={analysisTargetFps === fps}
              onPress={() => setAnalysisTargetFps(fps)}
            />
          ))}
        </View>

        <View style={styles.cameraControlRow}>
          <View>
            <Text style={styles.cameraControlLabel}>CAMERA</Text>
            <Text style={styles.cameraControlValue}>{cameraPosition.toUpperCase()}</Text>
          </View>
          <Pressable
            accessibilityLabel={`Use ${nextCameraPosition} camera`}
            accessibilityRole="button"
            accessibilityState={{ disabled: cameraFlipDisabled }}
            disabled={cameraFlipDisabled}
            onPress={flipCamera}
            style={({ pressed }) => [
              styles.cameraFlipButton,
              pressed && !cameraFlipDisabled && styles.actionButtonPressed,
              cameraFlipDisabled && styles.actionButtonDisabled,
            ]}>
            <Text style={styles.cameraFlipButtonText}>
              Use {nextCameraPosition} camera
            </Text>
          </Pressable>
        </View>

        <View style={styles.controls}>
          {sessionState === 'idle' ? (
            <ActionButton label="Start" tone="primary" onPress={() => void startSession()} />
          ) : (
            <ActionButton
              label={sessionState === 'stopping' ? 'Stopping…' : 'Stop'}
              tone="danger"
              disabled={sessionState !== 'running'}
              onPress={() => void stopSession()}
            />
          )}
          <ActionButton
            label="Next Item"
            disabled={sessionState !== 'running'}
            onPress={nextItem}
          />
          <ActionButton
            label="Dev infer"
            disabled={sessionState !== 'running' || isCapturing}
            onPress={runDevProbe}
          />
          <ActionButton
            label="Share trace"
            disabled={!traceRef.current}
            onPress={() => void shareTrace()}
          />
        </View>

        {!objectDetection.isReady && !objectDetection.error ? (
          <View style={styles.modelLoading}>
            <ActivityIndicator color="#C9D5EA" size="small" />
            <Text style={styles.modelLoadingText}>
              Downloading object detector {(objectDetection.downloadProgress * 100).toFixed(0)}%
            </Text>
          </View>
        ) : modelProbeRequested && !classification.isReady && !classification.error ? (
          <View style={styles.modelLoading}>
            <ActivityIndicator color="#C9D5EA" size="small" />
            <Text style={styles.modelLoadingText}>
              Downloading library model {(classification.downloadProgress * 100).toFixed(0)}%
            </Text>
          </View>
        ) : null}
      </View>
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
  scanGuideLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  topPanel: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    padding: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(8, 12, 19, 0.82)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    zIndex: 2,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  eyebrow: {
    color: '#8FA2BF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  heading: {
    color: '#F7FAFF',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 3,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  gateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  gatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  gatePillReady: {
    backgroundColor: 'rgba(52, 211, 153, 0.16)',
  },
  gatePillError: {
    backgroundColor: 'rgba(248, 113, 113, 0.18)',
  },
  gateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#718096',
  },
  gateDotReady: {
    backgroundColor: '#6DF5A8',
  },
  gateDotError: {
    backgroundColor: '#FB7185',
  },
  gatePillText: {
    color: '#E5ECF7',
    fontSize: 10,
    fontWeight: '600',
  },
  metricsGrid: {
    flexDirection: 'row',
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
    paddingTop: 10,
  },
  metricCell: {
    flex: 1,
  },
  metricValue: {
    color: '#F7FAFF',
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  metricLabel: {
    color: '#8FA2BF',
    fontSize: 9,
    marginTop: 1,
  },
  bottomPanel: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 10,
    padding: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(8, 12, 19, 0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    zIndex: 2,
  },
  soakHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  soakTime: {
    color: '#F7FAFF',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  soakLabel: {
    color: '#8FA2BF',
    fontSize: 10,
    marginTop: 1,
  },
  telemetryText: {
    color: '#B7C5DA',
    fontSize: 10,
    textTransform: 'capitalize',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginVertical: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#6DF5A8',
  },
  detailText: {
    color: '#B7C5DA',
    fontSize: 10,
    lineHeight: 15,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 4,
  },
  exportText: {
    color: '#93C5FD',
    fontSize: 9,
    lineHeight: 13,
    marginTop: 4,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  profileLabel: {
    flex: 1,
    color: '#8FA2BF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  profileButton: {
    minWidth: 48,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
  profileButtonSelected: {
    borderColor: '#6DF5A8',
    backgroundColor: 'rgba(52, 211, 153, 0.18)',
  },
  profileButtonText: {
    color: '#AAB6C9',
    fontSize: 10,
    fontWeight: '700',
  },
  profileButtonTextSelected: {
    color: '#D9FFEA',
  },
  cameraControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  cameraControlLabel: {
    color: '#8FA2BF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  cameraControlValue: {
    color: '#F7FAFF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 1,
  },
  cameraFlipButton: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#243047',
  },
  cameraFlipButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  actionButton: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingHorizontal: 8,
    backgroundColor: '#243047',
  },
  actionButtonPrimary: {
    backgroundColor: '#0F9F67',
  },
  actionButtonDanger: {
    backgroundColor: '#B73A4A',
  },
  actionButtonPressed: {
    opacity: 0.74,
  },
  actionButtonDisabled: {
    opacity: 0.38,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  modelLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 9,
  },
  modelLoadingText: {
    color: '#C9D5EA',
    fontSize: 10,
  },
});
