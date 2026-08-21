import type { Observable } from '@legendapp/state';
import { useCallback, useRef, type RefObject } from 'react';
import type { ScannedObject } from 'react-native-vision-camera';
import type { SharedValue } from 'react-native-reanimated';

import {
  captureQualityFailure,
  evaluateCapture,
  INITIAL_CAPTURE_POLICY_STATE,
  type CapturePolicyState,
  type FrameQualitySample,
  type SelectedCapture,
} from '../slice-one/capture-policy';
import {
  evaluateInventoryCaptureProposal,
  evaluateLabelAgnosticProposal,
  resolveObjectDetectionFrameSize,
} from '../slice-one/label-agnostic-proposal';
import {
  INITIAL_OBJECT_TRACKER_STATE,
  type ObjectTrack,
  type ObjectTrackerState,
  updateObjectTracker,
} from '../slice-one/object-tracker';
import {
  resolveSalientObjectShadow,
  selectCaptureTrack,
  type SalientObjectObservation,
} from '../slice-one/salient-object-shadow';
import type { SliceOneViewState } from './slice-one-view-state';
import type {
  CaptureGateOutcome,
  LabelAgnosticShadowCounters,
  SalientObjectShadowCounters,
  SessionItem,
} from './slice-one-types';
import { percentile, type SliceTrace } from './trace';
import type { AnalysisSample } from './use-slice-one-frame-output';

const SALIENT_OBJECT_TYPE = 'salient-object';

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

type UseSliceOneAnalysisPolicyOptions = {
  activeItemRef: RefObject<SessionItem>;
  captureInFlightRef: RefObject<boolean>;
  detectorReady: boolean;
  handleAnalysisFrame: (frameProcessingStartedAtMs: number) => boolean;
  isCameraSwitching: () => boolean;
  previousFrameSignature: SharedValue<number[]>;
  requestAutoCapture: (
    sample: FrameQualitySample,
    track: ObjectTrack,
    replaceCaptureId?: string
  ) => void;
  selectedCapturesRef: RefObject<SelectedCapture[]>;
  state$: Observable<SliceOneViewState>;
  stopRequestedRef: RefObject<boolean>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneAnalysisPolicy({
  activeItemRef,
  captureInFlightRef,
  detectorReady,
  handleAnalysisFrame,
  isCameraSwitching,
  previousFrameSignature,
  requestAutoCapture,
  selectedCapturesRef,
  state$,
  stopRequestedRef,
  traceRef,
}: UseSliceOneAnalysisPolicyOptions) {
  const frameDurationsRef = useRef<number[]>([]);
  const frameGateEventsRef = useRef(0);
  const captureGateCountsRef = useRef(emptyCaptureGateCounts());
  const analysisClockRef = useRef({ atMs: 0, inputFrames: 0, accepted: 0 });
  const firstAnalysisFrameIdRef = useRef<number | null>(null);
  const capturePolicyRef = useRef<CapturePolicyState>(INITIAL_CAPTURE_POLICY_STATE);
  const objectTrackerRef = useRef<ObjectTrackerState>(INITIAL_OBJECT_TRACKER_STATE);
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

  const resetItemTracking = useCallback(() => {
    resetCameraTracking();
    labelAgnosticSelectedCapturesRef.current = [];
    salientObjectSelectedCapturesRef.current = [];
  }, [resetCameraTracking]);

  const resetForSession = useCallback(() => {
    frameDurationsRef.current = [];
    frameGateEventsRef.current = 0;
    captureGateCountsRef.current = emptyCaptureGateCounts();
    labelAgnosticShadowCountersRef.current = emptyLabelAgnosticShadowCounters();
    salientObjectShadowCountersRef.current = emptySalientObjectShadowCounters();
    analysisClockRef.current = { atMs: 0, inputFrames: 0, accepted: 0 };
    firstAnalysisFrameIdRef.current = null;
    resetItemTracking();
  }, [resetItemTracking]);

  const getShadowCaptureSummary = useCallback(() => ({
    labelAgnosticSelectedCaptures: labelAgnosticSelectedCapturesRef.current.length,
    labelAgnosticSelectedCaptureIds: labelAgnosticSelectedCapturesRef.current
      .map((capture) => capture.id)
      .join(','),
    salientObjectSelectedCaptures: salientObjectSelectedCapturesRef.current.length,
    salientObjectSelectedCaptureIds: salientObjectSelectedCapturesRef.current
      .map((capture) => capture.id)
      .join(','),
  }), []);

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

  const onAnalysisSample = useCallback((sample: AnalysisSample) => {
    const now = performance.now();
    handleAnalysisFrame(sample.frameProcessingStartedAtMs);
    firstAnalysisFrameIdRef.current ??= sample.frameId;
    const inputFrames = Math.max(
      state$.metrics.inputFrames.peek(),
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

    analysisClockRef.current = { atMs: now, inputFrames, accepted: sample.accepted };
    frameDurationsRef.current.push(sample.durationMs);
    if (frameDurationsRef.current.length > 600) frameDurationsRef.current.shift();
    frameGateEventsRef.current += 1;

    state$.metrics.set({
      ...state$.metrics.peek(),
      inputFrames,
      previewFps,
      analysisRequested: sample.requested,
      analysisAccepted: sample.accepted,
      analysisRejected: sample.rejected,
      analysisFps,
      droppedFrames: state$.metrics.droppedFrames.peek(),
      detectionCount: sample.detections.length,
      gateP50Ms: percentile(frameDurationsRef.current, 0.5),
      gateP95Ms: percentile(frameDurationsRef.current, 0.95),
      brightness: sample.brightness,
      clippedRatio: sample.clippedRatio,
      motion: sample.motion,
      qualityScore: sample.qualityScore,
      sharpness: sample.sharpness,
      barcodeScans: state$.metrics.barcodeScans.peek() + (sample.barcodeScanned ? 1 : 0),
      lastBarcode: sample.barcodeValue
        ? `${sample.barcodeFormat ?? 'unknown'} ${sample.barcodeValue}`
        : state$.metrics.lastBarcode.peek(),
      objectConfidence: captureTrack?.score ?? 0,
      objectLabel: captureTrack?.label ?? 'none',
      resizeResult:
        sample.resizedWidth > 0 ? `${sample.resizedWidth}×${sample.resizedHeight}` : 'unavailable',
      trackId: captureTrack?.id ?? 'none',
    });

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
    const labelAgnosticResult = evaluateCapture(
      labelAgnosticCapturePolicyRef.current,
      { ...qualitySample, trackId: labelAgnosticTrack?.id ?? null },
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
      { ...qualitySample, trackId: salientObjectTrack?.id ?? null },
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
      cameraPosition: state$.cameraPosition.peek(),
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
      labelAgnosticSelectedCaptureCount: labelAgnosticSelectedCapturesRef.current.length,
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
      state$.qualityGateStatus.set('Stable view selected');
      requestAutoCapture(qualitySample, captureTrack, result.decision.replaceCaptureId);
    } else if (result.decision.action === 'hold') {
      const labels = {
        busy: 'Saving selected photo',
        cooldown: 'Move to another angle',
        duplicate: 'View is too similar',
        'no-object': detectorReady ? 'Center one object' : 'Preparing object detector',
        quality: 'Hold steady in even light',
        stabilizing: 'Stable — keep holding',
      } as const;
      state$.qualityGateStatus.set(labels[result.decision.reason]);
    } else {
      traceRef.current?.mark('capture.gate_invariant_error', {
        reason: 'capture-without-visible-track',
      });
    }
  }, [
    activeItemRef,
    captureInFlightRef,
    detectorReady,
    handleAnalysisFrame,
    isCameraSwitching,
    requestAutoCapture,
    selectedCapturesRef,
    state$,
    stopRequestedRef,
    traceRef,
  ]);

  return {
    captureGateCountsRef,
    frameGateEventsRef,
    getShadowCaptureSummary,
    labelAgnosticShadowCountersRef,
    onAnalysisSample,
    onSalientObjectsScanned,
    resetCameraTracking,
    resetForSession,
    resetItemTracking,
    salientObjectShadowCountersRef,
  };
}
