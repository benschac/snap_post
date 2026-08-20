export const CAPTURE_POLICY = {
  cooldownMs: 1_200,
  duplicateDistance: 7,
  maxSelectedCaptures: 3,
  minimumBrightness: 48,
  maximumBrightness: 212,
  maximumClippedRatio: 0.24,
  maximumMotion: 13,
  minimumQualityScore: 0.56,
  minimumSharpness: 11,
  replacementMargin: 0.06,
  stableFramesRequired: 3,
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
  stableFrames: number;
  stableTrackId: string | null;
};

export type CaptureDecision =
  | {
      action: 'hold';
      reason: 'busy' | 'cooldown' | 'duplicate' | 'no-object' | 'quality' | 'stabilizing';
    }
  | { action: 'capture'; replaceCaptureId?: string };

export const INITIAL_CAPTURE_POLICY_STATE: CapturePolicyState = {
  lastCaptureAtMs: Number.NEGATIVE_INFINITY,
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

export function isUsableSample(sample: FrameQualitySample) {
  return (
    sample.brightness >= CAPTURE_POLICY.minimumBrightness &&
    sample.brightness <= CAPTURE_POLICY.maximumBrightness &&
    sample.clippedRatio <= CAPTURE_POLICY.maximumClippedRatio &&
    sample.motion <= CAPTURE_POLICY.maximumMotion &&
    sample.qualityScore >= CAPTURE_POLICY.minimumQualityScore &&
    sample.sharpness >= CAPTURE_POLICY.minimumSharpness
  );
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
    return {
      decision: { action: 'hold', reason: 'no-object' },
      state: { ...state, stableFrames: 0, stableTrackId: null },
    };
  }

  if (!isUsableSample(sample)) {
    return {
      decision: { action: 'hold', reason: 'quality' },
      state: { ...state, stableFrames: 0, stableTrackId: null },
    };
  }

  const stableFrames = state.stableTrackId === sample.trackId ? state.stableFrames + 1 : 1;
  const nextState = { ...state, stableFrames, stableTrackId: sample.trackId };
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
      state: { ...state, stableFrames: 0, stableTrackId: null },
    };
  }

  if (selectedCaptures.length < CAPTURE_POLICY.maxSelectedCaptures) {
    return {
      decision: { action: 'capture' },
      state: { lastCaptureAtMs: sample.atMs, stableFrames: 0, stableTrackId: null },
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
    state: { lastCaptureAtMs: sample.atMs, stableFrames: 0, stableTrackId: null },
  };
}
