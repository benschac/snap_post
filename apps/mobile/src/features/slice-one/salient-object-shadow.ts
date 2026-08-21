import type { DetectionCandidate, ObjectTrack } from './object-tracker';

export const SALIENT_OBJECT_MAX_AGE_MS = 500;

export type NormalizedSalientObjectBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type SalientObjectObservation = {
  boxes: NormalizedSalientObjectBox[];
  receivedAtMs: number;
};

export type SalientObjectShadowResult = {
  ageMs: number | null;
  detections: DetectionCandidate[];
  freshness: 'fresh' | 'missing' | 'stale';
};

export type CaptureTrackSelection = {
  source: 'inventory-detector' | 'none' | 'salient-object';
  track: ObjectTrack | null;
};

function toDetection(
  box: NormalizedSalientObjectBox,
  frameWidth: number,
  frameHeight: number
): DetectionCandidate | null {
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > 1 ||
    box.y + box.height > 1
  ) {
    return null;
  }

  return {
    bbox: {
      x1: box.x * frameWidth,
      y1: box.y * frameHeight,
      x2: (box.x + box.width) * frameWidth,
      y2: (box.y + box.height) * frameHeight,
    },
    label: 'salient-object',
    score: 1,
  };
}

export function resolveSalientObjectShadow(
  observation: SalientObjectObservation | null,
  nowMs: number,
  frameWidth: number,
  frameHeight: number
): SalientObjectShadowResult {
  if (!observation) {
    return { ageMs: null, detections: [], freshness: 'missing' };
  }

  const ageMs = nowMs - observation.receivedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SALIENT_OBJECT_MAX_AGE_MS) {
    return { ageMs, detections: [], freshness: 'stale' };
  }

  return {
    ageMs,
    detections: observation.boxes
      .map((box) => toDetection(box, frameWidth, frameHeight))
      .filter((detection): detection is DetectionCandidate => detection !== null),
    freshness: 'fresh',
  };
}

export function selectCaptureTrack(
  inventoryTrack: ObjectTrack | null,
  salientObjectTrack: ObjectTrack | null
): CaptureTrackSelection {
  if (inventoryTrack) {
    return { source: 'inventory-detector', track: inventoryTrack };
  }
  if (salientObjectTrack) {
    return {
      source: 'salient-object',
      track: { ...salientObjectTrack, id: `salient-${salientObjectTrack.id}` },
    };
  }
  return { source: 'none', track: null };
}
