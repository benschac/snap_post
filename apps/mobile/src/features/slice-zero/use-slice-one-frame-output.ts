import type { Observable } from '@legendapp/state';
import { useCallback, type RefObject } from 'react';
import { Platform } from 'react-native';
import {
  CommonResolutions,
  type CameraOrientation,
  type Frame,
  useFrameOutput,
} from 'react-native-vision-camera';
import type { BarcodeScanner } from 'react-native-vision-camera-barcode-scanner';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  analysisFrameId,
  shouldAnalyzeFrame,
  type AnalysisTargetFps,
} from '../slice-one/analysis-profile';
import type { DetectionCandidate } from '../slice-one/object-tracker';
import { analyzeBgraPixels } from '../slice-one/rgb-quality';
import type { SliceOneViewState } from './slice-one-view-state';
import type { SliceTrace } from './trace';

const CAMERA_FPS = 30;
const FRAME_TIMESTAMP_SECONDS_SCALE = Platform.OS === 'android' ? 1 / 1_000_000_000 : 1;
const QUALITY_FRAME_SIZE = 64;
const SIGNATURE_GRID_SIZE = 8;

export type AnalysisSample = {
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

type UseSliceOneFrameOutputOptions = {
  analysisTargetFps: AnalysisTargetFps;
  barcodeScanner: BarcodeScanner;
  detectObjects: (frame: Frame) => DetectionCandidate[];
  droppedFramesRef: RefObject<number>;
  onAnalysisSample: (sample: AnalysisSample) => void;
  previousFrameSignature: SharedValue<number[]>;
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneFrameOutput({
  analysisTargetFps,
  barcodeScanner,
  detectObjects,
  droppedFramesRef,
  onAnalysisSample,
  previousFrameSignature,
  state$,
  traceRef,
}: UseSliceOneFrameOutputOptions) {
  const analysisRequested = useSharedValue(0);
  const analysisAccepted = useSharedValue(0);
  const analysisRejected = useSharedValue(0);

  const onAnalysisError = useCallback((message: string) => {
    state$.errorMessage.set(`Frame processor: ${message}`);
    traceRef.current?.mark('vision.frame_gate.error', { message });
  }, [state$, traceRef]);

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
      let barcodes = [] as ReturnType<BarcodeScanner['scanCodes']>;
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
    state$.metrics.set({ ...state$.metrics.peek(), droppedFrames });
    traceRef.current?.mark('vision.frame_dropped', { reason, droppedFrames });
  }, [droppedFramesRef, state$, traceRef]);

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_16_9,
    pixelFormat: 'rgb',
    dropFramesWhileBusy: true,
    onFrame,
    onFrameDropped,
  });

  const reset = useCallback(() => {
    analysisRequested.value = 0;
    analysisAccepted.value = 0;
    analysisRejected.value = 0;
  }, [analysisAccepted, analysisRejected, analysisRequested]);

  return {
    frameOutput,
    reset,
  };
}
