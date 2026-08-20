import { Canvas, Circle, Line, RoundedRect, vec } from '@shopify/react-native-skia';
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
  CommonResolutions,
  type Frame,
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
  ANALYSIS_TARGET_FPS_OPTIONS,
  analysisStride,
  type AnalysisTargetFps,
} from '../slice-one/analysis-profile';
import {
  evaluateCapture,
  INITIAL_CAPTURE_POLICY_STATE,
  type CapturePolicyState,
  type FrameQualitySample,
  type SelectedCapture,
} from '../slice-one/capture-policy';
import {
  INITIAL_OBJECT_TRACKER_STATE,
  type DetectionCandidate,
  type ObjectTrackerState,
  updateObjectTracker,
} from '../slice-one/object-tracker';
import { analyzeBgraPixels } from '../slice-one/rgb-quality';
import { summarizeCaptureLifecycle } from '../slice-one/session-summary';
import { percentile, SliceTrace } from './trace';

// VisionCamera Worklets 5.2.2 can accept an async task without executing its
// callback, retaining the Frame indefinitely. Keep quality analysis on the
// frame-output thread so ownership always ends in the same callback.
const AUDIO_STATS_UI_STRIDE = 10;
const CAMERA_FPS = 30;
const DETECTION_THRESHOLD = 0.5;
const SOAK_TARGET_MS = 10 * 60 * 1_000;
const BARCODE_FORMATS: TargetBarcodeFormat[] = ['ean-13', 'upc-a', 'qr-code', 'code-128'];
const PHOTO_PREVIEW_SIZE = { width: 320, height: 320 };
const QUALITY_FRAME_SIZE = 64;
const SIGNATURE_GRID_SIZE = 8;
const EXECUTORCH_MODEL = models.classification.efficientnet_v2_s();
const OBJECT_DETECTION_MODEL = models.object_detection.ssdlite_320_mobilenet_v3_large({
  backend: 'coreml',
});

type SessionState = 'idle' | 'starting' | 'running' | 'stopping';

type AnalysisSample = {
  inputFrames: number;
  requested: number;
  accepted: number;
  rejected: number;
  durationMs: number;
  detections: DetectionCandidate[];
  frameHeight: number;
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
};

type CompletedItem = {
  itemIndex: number;
  captures: Array<Pick<RetainedCapture, 'fileUri' | 'id' | 'qualityScore'>>;
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
  const cameraPermission = useCameraPermission();
  const microphonePermission = useMicrophonePermission();
  const cameraDevice = useCameraDevice('back', { physicalDevices: ['wide-angle'] });
  const photoOutput = usePhotoOutput({
    containerFormat: 'jpeg',
    qualityPrioritization: 'speed',
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
  const [currentItemIndex, setCurrentItemIndex] = useState(1);
  const [selectedCaptures, setSelectedCaptures] = useState<RetainedCapture[]>([]);
  const [qualityGateStatus, setQualityGateStatus] = useState('Waiting for a stable view');
  const [isCapturing, setIsCapturing] = useState(false);
  const [analysisTargetFps, setAnalysisTargetFps] = useState<AnalysisTargetFps>(5);

  const traceRef = useRef<SliceTrace | null>(null);
  const audioStatsRef = useRef<AudioStatsEvent | null>(null);
  const latestImageRef = useRef<Image | null>(null);
  const metricsRef = useRef(EMPTY_METRICS);
  const droppedFramesRef = useRef(0);
  const elapsedRef = useRef(0);
  const frameDurationsRef = useRef<number[]>([]);
  const analysisClockRef = useRef({ atMs: 0, inputFrames: 0, accepted: 0 });
  const firstPreviewSeenRef = useRef(false);
  const modelReadySeenRef = useRef(false);
  const detectorReadySeenRef = useRef(false);
  const captureInFlightRef = useRef(false);
  const activeCapturePromiseRef = useRef<Promise<void> | null>(null);
  const stopRequestedRef = useRef(false);
  const capturePolicyRef = useRef<CapturePolicyState>(INITIAL_CAPTURE_POLICY_STATE);
  const selectedCapturesRef = useRef<RetainedCapture[]>([]);
  const completedItemsRef = useRef<CompletedItem[]>([]);
  const currentItemFinalizedRef = useRef(false);
  const objectTrackerRef = useRef<ObjectTrackerState>(INITIAL_OBJECT_TRACKER_STATE);
  const sessionDirectoryRef = useRef<Directory | null>(null);
  const autoCaptureRef = useRef<
    ((sample: FrameQualitySample, replaceCaptureId?: string) => Promise<void>) | null
  >(null);

  const inputFrameCount = useSharedValue(0);
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
  const captureFeedbackStyle = useAnimatedStyle(() => ({
    opacity: captureFeedback.value,
    transform: [{ scale: 1 + captureFeedback.value * 0.035 }],
  }));
  const currentAnalysisStride = analysisStride(analysisTargetFps, CAMERA_FPS);
  const runObjectDetectionOnFrame = objectDetection.runOnFrame;

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  const replaceLatestImage = useCallback((image: Image) => {
    latestImageRef.current = image;
    setLatestImage(image);
  }, []);

  const onAnalysisSample = useCallback((sample: AnalysisSample) => {
    const now = performance.now();
    const trackingResult = updateObjectTracker(
      objectTrackerRef.current,
      sample.detections,
      sample.frameWidth,
      sample.frameHeight
    );
    objectTrackerRef.current = trackingResult.state;
    const visibleTrack = trackingResult.visibleTrack;
    const previous = analysisClockRef.current;
    const elapsed = previous.atMs > 0 ? now - previous.atMs : 0;
    const previewFps =
      elapsed > 0 ? ((sample.inputFrames - previous.inputFrames) * 1_000) / elapsed : 0;
    const analysisFps =
      elapsed > 0 ? ((sample.accepted - previous.accepted) * 1_000) / elapsed : 0;

    analysisClockRef.current = {
      atMs: now,
      inputFrames: sample.inputFrames,
      accepted: sample.accepted,
    };
    frameDurationsRef.current.push(sample.durationMs);
    if (frameDurationsRef.current.length > 600) frameDurationsRef.current.shift();

    const nextMetrics: Metrics = {
      ...metricsRef.current,
      inputFrames: sample.inputFrames,
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
      objectConfidence: visibleTrack?.score ?? 0,
      objectLabel: visibleTrack?.label ?? 'none',
      resizeResult:
        sample.resizedWidth > 0 ? `${sample.resizedWidth}×${sample.resizedHeight}` : 'unavailable',
      trackId: visibleTrack?.id ?? 'none',
    };
    metricsRef.current = nextMetrics;
    setMetrics(nextMetrics);

    traceRef.current?.mark('vision.frame_gate', {
      durationMs: sample.durationMs,
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      barcodeScanned: sample.barcodeScanned,
      barcode: sample.barcodeValue,
      detectionCount: sample.detections.length,
      objectLabel: visibleTrack?.label,
      objectConfidence: visibleTrack?.score,
      trackId: visibleTrack?.id,
    });

    const qualitySample: FrameQualitySample = {
      atMs: now,
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      signature: sample.signature,
      trackId: visibleTrack?.id ?? null,
    };
    const result = evaluateCapture(
      capturePolicyRef.current,
      qualitySample,
      selectedCapturesRef.current,
      captureInFlightRef.current || stopRequestedRef.current
    );
    capturePolicyRef.current = result.state;

    if (result.decision.action === 'capture') {
      setQualityGateStatus('Stable view selected');
      const capturePromise = autoCaptureRef.current?.(
        qualitySample,
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
    } else {
      const labels = {
        busy: 'Saving selected photo',
        cooldown: 'Move to another angle',
        duplicate: 'View is too similar',
        'no-object': objectDetection.isReady ? 'Center one object' : 'Preparing object detector',
        quality: 'Hold steady in even light',
        stabilizing: 'Stable — keep holding',
      } as const;
      setQualityGateStatus(labels[result.decision.reason]);
    }
  }, [objectDetection.isReady]);

  const onAnalysisError = useCallback((message: string) => {
    setErrorMessage(`Frame processor: ${message}`);
    traceRef.current?.mark('vision.frame_gate.error', { message });
  }, []);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      inputFrameCount.value += 1;
      const currentInputFrames = inputFrameCount.value;

      if (currentInputFrames % currentAnalysisStride !== 0) {
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
          inputFrames: currentInputFrames,
          requested,
          accepted: analysisAccepted.value,
          rejected: analysisRejected.value,
          durationMs: performance.now() - startedAt,
          detections,
          frameHeight: frame.height,
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
      barcodeScanner,
      currentAnalysisStride,
      inputFrameCount,
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

  const cameraOutputs = useMemo(() => [photoOutput, frameOutput], [frameOutput, photoOutput]);
  const cameraConstraints = useMemo(
    () => [{ fps: CAMERA_FPS }, { resolutionBias: frameOutput }],
    [frameOutput]
  );
  const isCameraActive =
    sessionState === 'running' && isFocused && cameraPermission.hasPermission;

  useEffect(() => {
    return () => {
      latestImageRef.current = null;
      selectedCapturesRef.current = [];
      void SnapNative?.stopPcmCapture();
    };
  }, []);

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
    frameDurationsRef.current = [];
    analysisClockRef.current = { atMs: 0, inputFrames: 0, accepted: 0 };
    inputFrameCount.value = 0;
    analysisRequested.value = 0;
    analysisAccepted.value = 0;
    analysisRejected.value = 0;
    previousFrameSignature.value = [];
    capturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    objectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    captureInFlightRef.current = false;
    stopRequestedRef.current = false;
    setIsCapturing(false);
    firstPreviewSeenRef.current = false;
    setCameraPreviewStarted(false);
    setExportUri(null);
  }, [analysisAccepted, analysisRejected, analysisRequested, inputFrameCount, previousFrameSignature]);

  const resetCurrentItem = useCallback(() => {
    selectedCapturesRef.current = [];
    setSelectedCaptures([]);
    currentItemFinalizedRef.current = false;
    capturePolicyRef.current = INITIAL_CAPTURE_POLICY_STATE;
    objectTrackerRef.current = INITIAL_OBJECT_TRACKER_STATE;
    previousFrameSignature.value = [];
    setQualityGateStatus('Waiting for a stable view');
    setCaptureStatus('No photos selected for this item');
  }, [previousFrameSignature]);

  const finalizeCurrentItem = useCallback(() => {
    if (currentItemFinalizedRef.current || selectedCapturesRef.current.length === 0) return;
    const item: CompletedItem = {
      itemIndex: currentItemIndex,
      captures: selectedCapturesRef.current.map(({ fileUri, id, qualityScore }) => ({
        fileUri,
        id,
        qualityScore,
      })),
    };
    completedItemsRef.current.push(item);
    currentItemFinalizedRef.current = true;
    traceRef.current?.mark('item.completed', {
      itemIndex: currentItemIndex,
      selectedCaptures: item.captures.length,
    });
  }, [currentItemIndex]);

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
        detectorModel: OBJECT_DETECTION_MODEL.modelName,
        detectorReady: objectDetection.isReady,
      });
      SnapNative?.mark('session.start_pressed', sessionId);
      resetCurrentItem();
      completedItemsRef.current = [];
      setCurrentItemIndex(1);
      const sessionDirectory = new Directory(Paths.document, 'slice-one', sessionId);
      sessionDirectory.create({ idempotent: true, intermediates: true });
      sessionDirectoryRef.current = sessionDirectory;
      trace.mark('item.started', { itemIndex: 1 });

      const startedAt = performance.now();
      setSessionStartedAt(startedAt);
      setSessionState('running');

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
    cameraPermission,
    microphonePermission,
    objectDetection.isReady,
    resetCurrentItem,
    resetSessionMetrics,
    sessionState,
  ]);

  const exportTrace = useCallback(() => {
    const trace = traceRef.current;
    if (!trace) return null;

    const currentTelemetry = SnapNative?.getTelemetry() ?? telemetry;
    const captureSummary = summarizeCaptureLifecycle(
      completedItemsRef.current.map((item) => item.captures.length),
      selectedCapturesRef.current.length,
      currentItemFinalizedRef.current
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
        durationMs: elapsedRef.current,
        soakTargetMet: elapsedRef.current >= SOAK_TARGET_MS,
        analysisTargetFps,
        inputFrames: metricsRef.current.inputFrames,
        analysisRequested: metricsRef.current.analysisRequested,
        analysisAccepted: metricsRef.current.analysisAccepted,
        analysisRejected: metricsRef.current.analysisRejected,
        droppedFrames: droppedFramesRef.current,
        barcodeScans: metricsRef.current.barcodeScans,
        resizeResult: metricsRef.current.resizeResult,
        gateP50Ms: metricsRef.current.gateP50Ms,
        gateP95Ms: metricsRef.current.gateP95Ms,
        completedItems: captureSummary.completedItems,
        activeSelectedPhotos: captureSummary.activeSelectedPhotos,
        selectedPhotos: captureSummary.selectedPhotos,
        captureDirectory: sessionDirectoryRef.current?.uri ?? null,
        audioChunks: audioStatsRef.current?.chunkIndex ?? 0,
        thermalState: currentTelemetry?.thermalState ?? 'unknown',
        residentMemoryBytes: currentTelemetry?.residentMemoryBytes ?? 0,
        detectorModel: OBJECT_DETECTION_MODEL.modelName,
        detectorReady: objectDetection.isReady,
        detectorError: objectDetection.error ? formatError(objectDetection.error) : null,
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
    classification.error,
    classification.isReady,
    objectDetection.error,
    objectDetection.isReady,
    telemetry,
  ]);

  const shareTrace = useCallback(async () => {
    try {
      setErrorMessage(null);
      const uri = exportTrace();
      if (!uri) throw new Error('Start a session before sharing its trace.');

      const traceFile = new File(uri);
      if (!traceFile.exists) throw new Error(`The trace file was not created at ${uri}`);

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error(
          'Native sharing is unavailable in this build. Rebuild and reinstall the development client.'
        );
      }

      await Sharing.shareAsync(uri, {
        UTI: 'public.json',
        mimeType: 'application/json',
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
    setSessionState('stopping');
    setQualityGateStatus('Finishing the current capture');
    await activeCapturePromiseRef.current;
    traceRef.current?.mark('session.stop_pressed');
    SnapNative?.mark('session.stop_pressed');

    try {
      const audioStop = await SnapNative?.stopPcmCapture();
      traceRef.current?.mark('speech.microphone_stopped', {
        chunks: audioStop?.chunks,
        durationMs: audioStop?.durationMs,
      });
    } catch (error) {
      traceRef.current?.mark('speech.stop.error', { message: formatError(error) });
    }

    finalizeCurrentItem();
    setSessionState('idle');
    exportTrace();
  }, [exportTrace, finalizeCurrentItem, sessionState]);

  const captureAutoCandidate = useCallback(
    async (sample: FrameQualitySample, replaceCaptureId?: string) => {
      if (sessionState !== 'running' || captureInFlightRef.current) return;
      const sessionDirectory = sessionDirectoryRef.current;
      if (!sessionDirectory) return;

      captureInFlightRef.current = true;
      setIsCapturing(true);
      const imageId = makeSessionId();
      const requestAt = performance.now();
      let previewImage: Image | undefined;
      let persistedFile: File | undefined;
      traceRef.current?.mark('capture.auto_requested', {
        imageId,
        itemIndex: currentItemIndex,
        qualityScore: sample.qualityScore,
        replacing: replaceCaptureId ?? null,
        trackId: sample.trackId,
      });

      try {
        const itemDirectory = new Directory(
          sessionDirectory,
          `item-${currentItemIndex.toString().padStart(3, '0')}`
        );
        itemDirectory.create({ idempotent: true, intermediates: true });
        const photoFile = await photoOutput.capturePhotoToFile(
          { enableShutterSound: false, flashMode: 'off' },
          {
            onPreviewImageAvailable: (image) => {
              previewImage = image;
            },
          }
        );
        const temporaryFile = new File(
          photoFile.filePath.startsWith('file://') ? photoFile.filePath : `file://${photoFile.filePath}`
        );
        persistedFile = new File(itemDirectory, `${imageId}.jpg`);
        await temporaryFile.move(persistedFile);

        const retained: RetainedCapture = {
          fileUri: persistedFile.uri,
          id: imageId,
          previewImage,
          qualityScore: sample.qualityScore,
          signature: sample.signature,
        };
        let nextCaptures = [...selectedCapturesRef.current];
        let replacedCapture: RetainedCapture | undefined;
        if (replaceCaptureId) {
          const replacedIndex = nextCaptures.findIndex((capture) => capture.id === replaceCaptureId);
          if (replacedIndex >= 0) {
            [replacedCapture] = nextCaptures.splice(replacedIndex, 1);
          }
        }
        nextCaptures.push(retained);
        nextCaptures.sort((left, right) => right.qualityScore - left.qualityScore);
        selectedCapturesRef.current = nextCaptures;
        setSelectedCaptures(nextCaptures);
        if (replacedCapture) {
          try {
            const replacedFile = new File(replacedCapture.fileUri);
            if (replacedFile.exists) replacedFile.delete();
          } catch (error) {
            traceRef.current?.mark('capture.replaced_file_cleanup_error', {
              imageId: replacedCapture.id,
              message: formatError(error),
            });
          }
        }
        setCaptureStatus(
          `${nextCaptures.length}/3 selected · quality ${(sample.qualityScore * 100).toFixed(0)}%`
        );
        setQualityGateStatus('Captured — move to another angle');
        captureFeedback.value = withSequence(
          withTiming(1, { duration: 60, reduceMotion: ReduceMotion.System }),
          withTiming(0, { duration: 260, reduceMotion: ReduceMotion.System })
        );
        try {
          Presets.System.notificationSuccess();
        } catch (error) {
          traceRef.current?.mark('capture.haptic_error', { message: formatError(error) });
        }
        traceRef.current?.mark('capture.auto_saved', {
          imageId,
          itemIndex: currentItemIndex,
          latencyMs: performance.now() - requestAt,
          qualityScore: sample.qualityScore,
          trackId: sample.trackId,
          selectedCaptures: nextCaptures.length,
        });
      } catch (error) {
        if (persistedFile?.exists) persistedFile.delete();
        const message = formatError(error);
        setErrorMessage(`Automatic capture: ${message}`);
        traceRef.current?.mark('capture.auto_error', { imageId, message });
      } finally {
        captureInFlightRef.current = false;
        setIsCapturing(false);
      }
    },
    [captureFeedback, currentItemIndex, photoOutput, sessionState]
  );
  autoCaptureRef.current = captureAutoCandidate;

  const nextItem = useCallback(() => {
    if (sessionState !== 'running' || captureInFlightRef.current) return;
    finalizeCurrentItem();
    resetCurrentItem();
    const nextIndex = currentItemIndex + 1;
    setCurrentItemIndex(nextIndex);
    traceRef.current?.mark('item.started', { itemIndex: nextIndex });
    Presets.System.selection();
  }, [currentItemIndex, finalizeCurrentItem, resetCurrentItem, sessionState]);

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

  const overlayInset = 30;
  const overlayWidth = Math.max(0, previewSize.width - overlayInset * 2);
  const overlayHeight = Math.max(0, Math.min(previewSize.height * 0.48, overlayWidth * 1.15));
  const overlayTop = Math.max(120, (previewSize.height - overlayHeight) / 2 - 20);
  const overlayColor =
    sessionState !== 'running' ? '#A8B1C4' : metrics.qualityScore >= 0.56 ? '#6DF5A8' : '#F6C85F';
  const soakProgress = Math.min(1, elapsedMs / SOAK_TARGET_MS);

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
          onConfigured={() => setCameraConfigured(true)}
          onPreviewStarted={() => {
            setCameraPreviewStarted(true);
            if (!firstPreviewSeenRef.current) {
              firstPreviewSeenRef.current = true;
              traceRef.current?.mark('camera.first_preview_frame');
              SnapNative?.mark('camera.first_preview_frame');
            }
          }}
          onError={(error) => {
            setErrorMessage(`Camera: ${error.message}`);
            traceRef.current?.mark('camera.error', { message: error.message });
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

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          <RoundedRect
            x={overlayInset}
            y={overlayTop}
            width={overlayWidth}
            height={overlayHeight}
            r={26}
            color={overlayColor}
            style="stroke"
            strokeWidth={3}
          />
          <Circle
            cx={previewSize.width / 2}
            cy={overlayTop + overlayHeight / 2}
            r={4}
            color={overlayColor}
          />
          <Line
            p1={vec(previewSize.width / 2 - 22, overlayTop + overlayHeight / 2)}
            p2={vec(previewSize.width / 2 + 22, overlayTop + overlayHeight / 2)}
            color={overlayColor}
            strokeWidth={1}
          />
          <Line
            p1={vec(previewSize.width / 2, overlayTop + overlayHeight / 2 - 22)}
            p2={vec(previewSize.width / 2, overlayTop + overlayHeight / 2 + 22)}
            color={overlayColor}
            strokeWidth={1}
          />
        </Canvas>
      </View>
      <Animated.View
        pointerEvents="none"
        style={[styles.captureFeedback, captureFeedbackStyle]}
      />

      <View style={styles.topPanel}>
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

      <View style={[styles.bottomPanel, { bottom: Math.max(10, insets.bottom + 8) }]}>
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
            disabled={sessionState !== 'running' || isCapturing}
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
