import { Canvas, Circle, Line, RoundedRect, vec } from '@shopify/react-native-skia';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { File } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NitroImage, type Image } from 'react-native-nitro-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isAvailable as isExecutorchAvailable,
  models,
  useClassification,
} from 'react-native-executorch';
import { useSharedValue } from 'react-native-reanimated';
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
import { useResizer } from 'react-native-vision-camera-resizer';
import { scheduleOnRN } from 'react-native-worklets';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type {
  AudioStatsEvent,
  NativeTelemetry,
} from '../../../modules/snap-native/src/SnapNative.types';
import { percentile, SliceZeroTrace } from './trace';

// VisionCamera Worklets 5.2.2 can accept an async task without executing its
// callback, retaining the Frame indefinitely. Keep this compatibility probe on
// the frame-output thread at 1 Hz so ownership always ends in the same callback.
const ANALYSIS_STRIDE = 30;
const AUDIO_STATS_UI_STRIDE = 10;
const SOAK_TARGET_MS = 10 * 60 * 1_000;
const BARCODE_FORMATS: TargetBarcodeFormat[] = ['ean-13', 'upc-a', 'qr-code', 'code-128'];
const PHOTO_PREVIEW_SIZE = { width: 320, height: 320 };
const EXECUTORCH_MODEL = models.classification.efficientnet_v2_s();

type SessionState = 'idle' | 'starting' | 'running' | 'stopping';

type AnalysisSample = {
  inputFrames: number;
  requested: number;
  accepted: number;
  rejected: number;
  durationMs: number;
  resizedWidth: number;
  resizedHeight: number;
  barcodeValue?: string;
  barcodeFormat?: string;
  barcodeScanned: boolean;
};

type Metrics = {
  inputFrames: number;
  previewFps: number;
  analysisRequested: number;
  analysisAccepted: number;
  analysisRejected: number;
  analysisFps: number;
  droppedFrames: number;
  gateP50Ms: number;
  gateP95Ms: number;
  lastBarcode: string;
  barcodeScans: number;
  resizeResult: string;
};

const EMPTY_METRICS: Metrics = {
  inputFrames: 0,
  previewFps: 0,
  analysisRequested: 0,
  analysisAccepted: 0,
  analysisRejected: 0,
  analysisFps: 0,
  droppedFrames: 0,
  gateP50Ms: 0,
  gateP95Ms: 0,
  lastBarcode: 'none',
  barcodeScans: 0,
  resizeResult: 'pending',
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

export function SliceZeroScreen() {
  const insets = useSafeAreaInsets();
  const [isFocused, setIsFocused] = useState(false);
  const cameraPermission = useCameraPermission();
  const microphonePermission = useMicrophonePermission();
  const cameraDevice = useCameraDevice('back', { physicalDevices: ['wide-angle'] });
  const photoOutput = usePhotoOutput({
    qualityPrioritization: 'speed',
    previewImageTargetSize: PHOTO_PREVIEW_SIZE,
  });
  const barcodeScanner = useBarcodeScanner({ barcodeFormats: BARCODE_FORMATS });
  const resizerState = useResizer({
    width: 224,
    height: 224,
    channelOrder: 'rgb',
    dataType: 'uint8',
    scaleMode: 'cover',
    pixelLayout: 'planar',
  });
  const resizer = resizerState.resizer;

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

  const traceRef = useRef<SliceZeroTrace | null>(null);
  const audioStatsRef = useRef<AudioStatsEvent | null>(null);
  const latestImageRef = useRef<Image | null>(null);
  const metricsRef = useRef(EMPTY_METRICS);
  const droppedFramesRef = useRef(0);
  const elapsedRef = useRef(0);
  const frameDurationsRef = useRef<number[]>([]);
  const analysisClockRef = useRef({ atMs: 0, inputFrames: 0, accepted: 0 });
  const firstPreviewSeenRef = useRef(false);
  const modelReadySeenRef = useRef(false);

  const inputFrameCount = useSharedValue(0);
  const analysisRequested = useSharedValue(0);
  const analysisAccepted = useSharedValue(0);
  const analysisRejected = useSharedValue(0);

  const classification = useClassification({
    model: EXECUTORCH_MODEL,
    preventLoad: !modelProbeRequested,
  });

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  const replaceLatestImage = useCallback((image: Image) => {
    latestImageRef.current?.dispose();
    latestImageRef.current = image;
    setLatestImage(image);
  }, []);

  const onAnalysisSample = useCallback((sample: AnalysisSample) => {
    const now = performance.now();
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
      gateP50Ms: percentile(frameDurationsRef.current, 0.5),
      gateP95Ms: percentile(frameDurationsRef.current, 0.95),
      barcodeScans: metricsRef.current.barcodeScans + (sample.barcodeScanned ? 1 : 0),
      lastBarcode: sample.barcodeValue
        ? `${sample.barcodeFormat ?? 'unknown'} ${sample.barcodeValue}`
        : metricsRef.current.lastBarcode,
      resizeResult:
        sample.resizedWidth > 0 ? `${sample.resizedWidth}×${sample.resizedHeight}` : 'unavailable',
    };
    metricsRef.current = nextMetrics;
    setMetrics(nextMetrics);

    traceRef.current?.mark('vision.frame_gate', {
      durationMs: sample.durationMs,
      accepted: sample.accepted,
      rejected: sample.rejected,
      barcodeScanned: sample.barcodeScanned,
      barcode: sample.barcodeValue,
    });
  }, []);

  const onAnalysisError = useCallback((message: string) => {
    setErrorMessage(`Frame processor: ${message}`);
    traceRef.current?.mark('vision.frame_gate.error', { message });
  }, []);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      inputFrameCount.value += 1;
      const currentInputFrames = inputFrameCount.value;

      if (currentInputFrames % ANALYSIS_STRIDE !== 0) {
        frame.dispose();
        return;
      }

      analysisRequested.value += 1;
      const requested = analysisRequested.value;
      const startedAt = performance.now();
      let resizedFrame;
      let barcodes: Barcode[] = [];
      try {
        resizedFrame = resizer?.resize(frame);
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
          resizedWidth: resizedFrame?.width ?? 0,
          resizedHeight: resizedFrame?.height ?? 0,
          barcodeValue,
          barcodeFormat,
          barcodeScanned: true,
        });
      } catch (error) {
        analysisRejected.value += 1;
        scheduleOnRN(onAnalysisError, String(error));
      } finally {
        for (const barcode of barcodes) barcode.dispose();
        resizedFrame?.dispose();
        frame.dispose();
      }
    },
    [
      analysisAccepted,
      analysisRejected,
      analysisRequested,
      barcodeScanner,
      inputFrameCount,
      onAnalysisError,
      onAnalysisSample,
      resizer,
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
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    onFrame,
    onFrameDropped,
  });

  const cameraOutputs = useMemo(() => [photoOutput, frameOutput], [frameOutput, photoOutput]);
  const cameraConstraints = useMemo(
    () => [{ fps: 30 as const }, { resolutionBias: frameOutput }],
    [frameOutput]
  );
  const isCameraActive =
    sessionState === 'running' && isFocused && cameraPermission.hasPermission;

  useEffect(() => {
    return () => {
      latestImageRef.current?.dispose();
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
    firstPreviewSeenRef.current = false;
    setCameraPreviewStarted(false);
    setExportUri(null);
  }, [analysisAccepted, analysisRejected, analysisRequested, inputFrameCount]);

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
        throw new Error('Camera and microphone permissions are required for Slice 0.');
      }

      const sessionId = makeSessionId();
      const trace = new SliceZeroTrace(sessionId);
      traceRef.current = trace;
      trace.mark('session.start_pressed');
      SnapNative?.mark('session.start_pressed', sessionId);
      setModelProbeRequested(true);

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
  }, [cameraPermission, microphonePermission, resetSessionMetrics, sessionState]);

  const exportTrace = useCallback(() => {
    const trace = traceRef.current;
    if (!trace) return null;

    const currentTelemetry = SnapNative?.getTelemetry() ?? telemetry;
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
        inputFrames: metricsRef.current.inputFrames,
        analysisRequested: metricsRef.current.analysisRequested,
        analysisAccepted: metricsRef.current.analysisAccepted,
        analysisRejected: metricsRef.current.analysisRejected,
        droppedFrames: droppedFramesRef.current,
        barcodeScans: metricsRef.current.barcodeScans,
        resizeResult: metricsRef.current.resizeResult,
        gateP50Ms: metricsRef.current.gateP50Ms,
        gateP95Ms: metricsRef.current.gateP95Ms,
        audioChunks: audioStatsRef.current?.chunkIndex ?? 0,
        thermalState: currentTelemetry?.thermalState ?? 'unknown',
        residentMemoryBytes: currentTelemetry?.residentMemoryBytes ?? 0,
        modelReady: classification.isReady,
        modelError: classification.error ? formatError(classification.error) : null,
      },
    });
    setExportUri(uri);
    return uri;
  }, [classification.error, classification.isReady, telemetry]);

  const stopSession = useCallback(async () => {
    if (sessionState !== 'running') return;
    setSessionState('stopping');
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

    setSessionState('idle');
    exportTrace();
  }, [exportTrace, sessionState]);

  const captureAndProbe = useCallback(async () => {
    if (sessionState !== 'running') return;

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
    }
  }, [
    classification,
    photoOutput,
    replaceLatestImage,
    sessionState,
  ]);

  const onPreviewLayout = useCallback((event: LayoutChangeEvent) => {
    setPreviewSize(event.nativeEvent.layout);
  }, []);

  const overlayInset = 30;
  const overlayWidth = Math.max(0, previewSize.width - overlayInset * 2);
  const overlayHeight = Math.max(0, Math.min(previewSize.height * 0.48, overlayWidth * 1.15));
  const overlayTop = Math.max(120, (previewSize.height - overlayHeight) / 2 - 20);
  const overlayColor = sessionState === 'running' ? '#6DF5A8' : '#A8B1C4';
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
          <Text style={styles.permissionTitle}>Slice 0 native gate</Text>
          <Text style={styles.permissionText}>
            Start requests camera and microphone access, then keeps one camera session warm.
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

      <View style={styles.topPanel}>
        <View style={styles.headingRow}>
          <View>
            <Text style={styles.eyebrow}>SLICE 0 · NATIVE COMPATIBILITY</Text>
            <Text style={styles.heading}>
              {sessionState === 'running' ? 'Capture pipeline live' : 'Ready to climb the gates'}
            </Text>
          </View>
          {latestImage ? <NitroImage image={latestImage} style={styles.thumbnail} /> : null}
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
            label="Resizer"
            status={
              resizerState.state === 'error'
                ? 'error'
                : metrics.resizeResult === '224×224'
                  ? 'ready'
                  : 'pending'
            }
          />
          <GatePill
            label="Barcode"
            status={metrics.barcodeScans > 0 ? 'ready' : 'pending'}
          />
          <GatePill
            label="ExecuTorch"
            status={classification.error ? 'error' : classification.isReady ? 'ready' : 'pending'}
          />
          <GatePill label="PCM" status={audioStats ? 'ready' : 'pending'} />
        </View>

        <View style={styles.metricsGrid}>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.previewFps.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>preview fps</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.analysisFps.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>analysis fps</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.gateP95Ms.toFixed(1)}</Text>
            <Text style={styles.metricLabel}>gate p95 ms</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricValue}>{metrics.droppedFrames}</Text>
            <Text style={styles.metricLabel}>dropped</Text>
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
          Frames {metrics.inputFrames} · requested {metrics.analysisRequested} · accepted{' '}
          {metrics.analysisAccepted} · rejected {metrics.analysisRejected}
        </Text>
        <Text style={styles.detailText} numberOfLines={1}>
          Resizer {metrics.resizeResult} · Barcode {metrics.lastBarcode}
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
            label="Capture + infer"
            disabled={sessionState !== 'running'}
            onPress={() => void captureAndProbe()}
          />
          <ActionButton
            label="Export trace"
            disabled={!traceRef.current}
            onPress={() => exportTrace()}
          />
        </View>

        {modelProbeRequested && !classification.isReady && !classification.error ? (
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
