export const CAPTURE_POLICY = {
  cooldownMs: 1_200,
  duplicateDistance: 7,
  maxSelectedCaptures: 3,
  minimumBrightness: 48,
  maximumBrightness: 212,
  maximumClippedRatio: 0.24,
  maximumMotion: 20,
  minimumQualityScore: 0.56,
  minimumSharpness: 11,
  replacementMargin: 0.06,
  stabilityWindowSize: 3,
  stableFramesRequired: 2,
} as const;

export type FrameQualitySample = {
  atMs: number;
  brightness: number;
  clippedRatio: number;
  motion: number;
  qualityScore: number;
  sharpness: number;
  signature: number[];
  trackId: string | null;
};

export type SelectedCapture = {
  id: string;
  qualityScore: number;
  signature: number[];
};

export type CapturePolicyState = {
  lastCaptureAtMs: number;
  recentTrackIds: Array<string | null>;
  stableFrames: number;
  stableTrackId: string | null;
};

export type CaptureQualityFailure =
  | 'brightness-high'
  | 'brightness-low'
  | 'clipped'
  | 'motion'
  | 'quality-score'
  | 'sharpness';

export type CaptureDecision =
  | {
      action: 'hold';
      reason: 'busy' | 'cooldown' | 'duplicate' | 'no-object' | 'quality' | 'stabilizing';
    }
  | { action: 'capture'; replaceCaptureId?: string };

export const INITIAL_CAPTURE_POLICY_STATE: CapturePolicyState = {
  lastCaptureAtMs: Number.NEGATIVE_INFINITY,
  recentTrackIds: [],
  stableFrames: 0,
  stableTrackId: null,
};

export function signatureDistance(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return Number.POSITIVE_INFINITY;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length;
}

export function captureQualityFailure(
  sample: FrameQualitySample
): CaptureQualityFailure | null {
  if (sample.brightness < CAPTURE_POLICY.minimumBrightness) return 'brightness-low';
  if (sample.brightness > CAPTURE_POLICY.maximumBrightness) return 'brightness-high';
  if (sample.clippedRatio > CAPTURE_POLICY.maximumClippedRatio) return 'clipped';
  if (sample.motion > CAPTURE_POLICY.maximumMotion) return 'motion';
  if (sample.qualityScore < CAPTURE_POLICY.minimumQualityScore) return 'quality-score';
  if (sample.sharpness < CAPTURE_POLICY.minimumSharpness) return 'sharpness';
  return null;
}

export function isUsableSample(sample: FrameQualitySample) {
  return captureQualityFailure(sample) === null;
}

function appendTrackObservation(state: CapturePolicyState, trackId: string | null) {
  return [...(state.recentTrackIds ?? []), trackId].slice(-CAPTURE_POLICY.stabilityWindowSize);
}

export function evaluateCapture(
  state: CapturePolicyState,
  sample: FrameQualitySample,
  selectedCaptures: SelectedCapture[],
  captureInFlight: boolean
): { decision: CaptureDecision; state: CapturePolicyState } {
  if (captureInFlight) {
    return { decision: { action: 'hold', reason: 'busy' }, state };
  }

  if (!sample.trackId) {
    const recentTrackIds = appendTrackObservation(state, null);
    return {
      decision: { action: 'hold', reason: 'no-object' },
      state: { ...state, recentTrackIds, stableFrames: 0, stableTrackId: null },
    };
  }

  if (!isUsableSample(sample)) {
    const recentTrackIds = appendTrackObservation(state, null);
    return {
      decision: { action: 'hold', reason: 'quality' },
      state: { ...state, recentTrackIds, stableFrames: 0, stableTrackId: null },
    };
  }

  const recentTrackIds = appendTrackObservation(state, sample.trackId);
  const stableFrames = recentTrackIds.filter((trackId) => trackId === sample.trackId).length;
  const nextState = { ...state, recentTrackIds, stableFrames, stableTrackId: sample.trackId };
  if (stableFrames < CAPTURE_POLICY.stableFramesRequired) {
    return { decision: { action: 'hold', reason: 'stabilizing' }, state: nextState };
  }

  if (sample.atMs - state.lastCaptureAtMs < CAPTURE_POLICY.cooldownMs) {
    return { decision: { action: 'hold', reason: 'cooldown' }, state: nextState };
  }

  const duplicate = selectedCaptures.some(
    (capture) => signatureDistance(capture.signature, sample.signature) < CAPTURE_POLICY.duplicateDistance
  );
  if (duplicate) {
    return {
      decision: { action: 'hold', reason: 'duplicate' },
      state: { ...state, recentTrackIds: [], stableFrames: 0, stableTrackId: null },
    };
  }

  if (selectedCaptures.length < CAPTURE_POLICY.maxSelectedCaptures) {
    return {
      decision: { action: 'capture' },
      state: {
        lastCaptureAtMs: sample.atMs,
        recentTrackIds: [],
        stableFrames: 0,
        stableTrackId: null,
      },
    };
  }

  const worstCapture = selectedCaptures.reduce((worst, capture) =>
    capture.qualityScore < worst.qualityScore ? capture : worst
  );
  if (sample.qualityScore < worstCapture.qualityScore + CAPTURE_POLICY.replacementMargin) {
    return { decision: { action: 'hold', reason: 'quality' }, state: nextState };
  }

  return {
    decision: { action: 'capture', replaceCaptureId: worstCapture.id },
    state: {
      lastCaptureAtMs: sample.atMs,
      recentTrackIds: [],
      stableFrames: 0,
      stableTrackId: null,
    },
  };
}
