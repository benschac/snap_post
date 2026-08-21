import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  isAvailable,
  models,
  useClassification,
  useObjectDetection,
} from 'react-native-executorch';
import type { Frame } from 'react-native-vision-camera';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type { DetectionCandidate } from '../slice-one/object-tracker';
import type { SliceTrace } from './trace';

const CLASSIFICATION_MODEL = models.classification.efficientnet_v2_s();
const OBJECT_DETECTION_MODEL = models.object_detection.ssdlite_320_mobilenet_v3_large({
  backend: 'coreml',
});
const OBJECT_DETECTION_THRESHOLD = 0.5;

type UseSliceOneExecuTorchOptions = {
  modelProbeRequested: boolean;
  setErrorMessage: (message: string) => void;
  setModelResult: (result: string) => void;
  traceRef: RefObject<SliceTrace | null>;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useSliceOneExecuTorch({
  modelProbeRequested,
  setErrorMessage,
  setModelResult,
  traceRef,
}: UseSliceOneExecuTorchOptions) {
  const classificationReadySeenRef = useRef(false);
  const detectorReadySeenRef = useRef(false);
  const classification = useClassification({
    model: CLASSIFICATION_MODEL,
    preventLoad: !modelProbeRequested,
  });
  const objectDetection = useObjectDetection({
    model: OBJECT_DETECTION_MODEL,
  });
  const runClassificationForward = classification.forward;
  const runObjectDetectionOnFrame = objectDetection.runOnFrame;

  useEffect(() => {
    if (!classification.isReady || classificationReadySeenRef.current) return;

    classificationReadySeenRef.current = true;
    setModelResult('EfficientNet ready — capture to run inference');
    traceRef.current?.mark('executorch.model_ready', {
      model: CLASSIFICATION_MODEL.modelName,
    });
    SnapNative?.mark('executorch.model_ready', CLASSIFICATION_MODEL.modelName);
  }, [classification.isReady, setModelResult, traceRef]);

  useEffect(() => {
    if (!classification.error) return;

    const message = formatError(classification.error);
    setModelResult(`Fallback armed: ${message}`);
    traceRef.current?.mark('executorch.model_failed', { message });
  }, [classification.error, setModelResult, traceRef]);

  useEffect(() => {
    if (!objectDetection.isReady || detectorReadySeenRef.current) return;

    detectorReadySeenRef.current = true;
    traceRef.current?.mark('object_detection.model_ready', {
      model: OBJECT_DETECTION_MODEL.modelName,
    });
    SnapNative?.mark('object_detection.model_ready', OBJECT_DETECTION_MODEL.modelName);
  }, [objectDetection.isReady, traceRef]);

  useEffect(() => {
    if (!objectDetection.error) return;

    const message = formatError(objectDetection.error);
    setErrorMessage(`Object detector: ${message}`);
    traceRef.current?.mark('object_detection.model_failed', { message });
  }, [objectDetection.error, setErrorMessage, traceRef]);

  const runClassification = useCallback(
    async (imageUri: string, imageId: string) => {
      const trace = traceRef.current;
      const inferenceSpan = trace?.beginSpan('executorch.inference', { imageId });
      const nativeInferenceSpan = SnapNative?.beginSpan('executorch.inference', imageId);

      try {
        const result = await runClassificationForward(imageUri);
        const topResults = Object.entries(result as Record<string, number>)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3);
        const resultLabel = topResults
          .map(([label, confidence]) => `${label} ${(confidence * 100).toFixed(1)}%`)
          .join(' · ');
        const topLabel = topResults[0]?.[0];

        setModelResult(resultLabel || 'Inference returned no labels');
        if (inferenceSpan) trace?.endSpan(inferenceSpan, { topLabel });
        if (nativeInferenceSpan) {
          SnapNative?.endSpan(nativeInferenceSpan, 'executorch.inference', topLabel);
        }
      } catch (error) {
        const message = formatError(error);
        if (inferenceSpan) trace?.endSpan(inferenceSpan, { error: message });
        if (nativeInferenceSpan) {
          SnapNative?.endSpan(nativeInferenceSpan, 'executorch.inference', message);
        }
        throw error;
      }
    },
    [runClassificationForward, setModelResult, traceRef]
  );

  const detectObjects = useCallback(
    (frame: Frame): DetectionCandidate[] => {
      'worklet';
      if (!runObjectDetectionOnFrame) return [];

      return runObjectDetectionOnFrame(frame, false, {
        detectionThreshold: OBJECT_DETECTION_THRESHOLD,
      }).map((detection) => ({
        bbox: detection.bbox,
        label: String(detection.label).toLowerCase(),
        score: detection.score,
      }));
    },
    [runObjectDetectionOnFrame]
  );

  return {
    classificationDownloadProgress: classification.downloadProgress,
    classificationError: classification.error ? formatError(classification.error) : null,
    classificationReady: classification.isReady,
    detectorDownloadProgress: objectDetection.downloadProgress,
    detectorError: objectDetection.error ? formatError(objectDetection.error) : null,
    detectorModelName: OBJECT_DETECTION_MODEL.modelName,
    detectorReady: objectDetection.isReady,
    detectorThreshold: OBJECT_DETECTION_THRESHOLD,
    detectObjects,
    executorchAvailable: isAvailable,
    runClassification,
  };
}
