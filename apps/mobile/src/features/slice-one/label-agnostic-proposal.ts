import type { DetectionBox, DetectionCandidate } from './object-tracker';
import { OBJECT_TRACKER_POLICY } from './object-tracker.ts';

export const LABEL_AGNOSTIC_PROPOSAL_POLICY = {
  centerMaximumXRatio: 0.8,
  centerMaximumYRatio: 0.8,
  centerMinimumXRatio: 0.2,
  centerMinimumYRatio: 0.2,
  edgeInsetRatio: 0.025,
  maximumAreaRatio: 0.45,
  minimumAreaRatio: 0.05,
  minimumCenterOverlapRatio: 0.7,
  minimumScore: 0.5,
} as const;

export type LabelAgnosticProposalRejection =
  | 'area-high'
  | 'area-low'
  | 'center-outside'
  | 'center-overlap-low'
  | 'edge-proximity'
  | 'invalid-box'
  | 'no-detections'
  | 'score-low';

export type LabelAgnosticProposal =
  | {
      candidate: DetectionCandidate;
      outcome: 'accepted';
    }
  | {
      candidate: DetectionCandidate | null;
      outcome: LabelAgnosticProposalRejection;
    };

export type DetectionOverlay = {
  accepted: boolean;
  bbox: DetectionBox;
  frameHeight: number;
  frameWidth: number;
};

export type PreviewDetectionRect = {
  color: string;
  height: number;
  width: number;
  x: number;
  y: number;
};

export function createDetectionOverlay(
  proposal: LabelAgnosticProposal,
  frameWidth: number,
  frameHeight: number
): DetectionOverlay | null {
  const candidate = proposal.candidate;
  if (
    !candidate ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    !Number.isFinite(candidate.bbox.x1) ||
    !Number.isFinite(candidate.bbox.y1) ||
    !Number.isFinite(candidate.bbox.x2) ||
    !Number.isFinite(candidate.bbox.y2) ||
    candidate.bbox.x2 <= candidate.bbox.x1 ||
    candidate.bbox.y2 <= candidate.bbox.y1
  ) {
    return null;
  }

  return {
    accepted: proposal.outcome === 'accepted',
    bbox: candidate.bbox,
    frameHeight,
    frameWidth,
  };
}

export function mapDetectionOverlayToPreview(
  overlay: DetectionOverlay | null,
  previewWidth: number,
  previewHeight: number,
  mirrored: boolean
): PreviewDetectionRect {
  'worklet';
  if (!overlay || previewWidth <= 0 || previewHeight <= 0) {
    return { color: 'transparent', height: 0, width: 0, x: 0, y: 0 };
  }

  const scale = Math.max(
    previewWidth / overlay.frameWidth,
    previewHeight / overlay.frameHeight
  );
  const offsetX = (previewWidth - overlay.frameWidth * scale) / 2;
  const offsetY = (previewHeight - overlay.frameHeight * scale) / 2;
  const rawLeft = overlay.bbox.x1 * scale + offsetX;
  const rawRight = overlay.bbox.x2 * scale + offsetX;
  const left = mirrored ? previewWidth - rawRight : rawLeft;
  const right = mirrored ? previewWidth - rawLeft : rawRight;
  const top = overlay.bbox.y1 * scale + offsetY;
  const bottom = overlay.bbox.y2 * scale + offsetY;
  const x = Math.max(0, Math.min(previewWidth, left));
  const y = Math.max(0, Math.min(previewHeight, top));
  const clippedRight = Math.max(0, Math.min(previewWidth, right));
  const clippedBottom = Math.max(0, Math.min(previewHeight, bottom));

  return {
    color: overlay.accepted ? '#6DF5A8' : '#F6C85F',
    height: Math.max(0, clippedBottom - y),
    width: Math.max(0, clippedRight - x),
    x,
    y,
  };
}

export function captureProposalGuidance(outcome: LabelAgnosticProposal['outcome']) {
  switch (outcome) {
    case 'area-low':
      return 'Move closer';
    case 'area-high':
      return 'Move farther away';
    case 'center-outside':
    case 'center-overlap-low':
      return 'Center the item';
    case 'edge-proximity':
      return 'Keep the whole item in frame';
    case 'invalid-box':
      return 'Reframe the item';
    case 'no-detections':
    case 'score-low':
      return 'Center one item';
    case 'accepted':
      return 'Hold steady';
  }
}

export function resolveObjectDetectionFrameSize(frameWidth: number, frameHeight: number) {
  // react-native-executorch maps frame detections back into screen space, whose
  // axes are swapped relative to VisionCamera's raw sensor-frame dimensions.
  return { height: frameWidth, width: frameHeight };
}

function boxArea(box: DetectionBox) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function intersectionArea(left: DetectionBox, right: DetectionBox) {
  return boxArea({
    x1: Math.max(left.x1, right.x1),
    y1: Math.max(left.y1, right.y1),
    x2: Math.min(left.x2, right.x2),
    y2: Math.min(left.y2, right.y2),
  });
}

function evaluateCandidate(
  candidate: DetectionCandidate,
  frameWidth: number,
  frameHeight: number
): LabelAgnosticProposalRejection | null {
  const { bbox } = candidate;
  if (
    !Number.isFinite(candidate.score) ||
    !Number.isFinite(bbox.x1) ||
    !Number.isFinite(bbox.y1) ||
    !Number.isFinite(bbox.x2) ||
    !Number.isFinite(bbox.y2) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    bbox.x2 <= bbox.x1 ||
    bbox.y2 <= bbox.y1
  ) {
    return 'invalid-box';
  }
  if (candidate.score < LABEL_AGNOSTIC_PROPOSAL_POLICY.minimumScore) return 'score-low';

  const frameArea = frameWidth * frameHeight;
  const area = boxArea(bbox);
  const areaRatio = area / frameArea;
  if (areaRatio < LABEL_AGNOSTIC_PROPOSAL_POLICY.minimumAreaRatio) return 'area-low';
  if (areaRatio > LABEL_AGNOSTIC_PROPOSAL_POLICY.maximumAreaRatio) return 'area-high';

  const edgeInsetX = frameWidth * LABEL_AGNOSTIC_PROPOSAL_POLICY.edgeInsetRatio;
  const edgeInsetY = frameHeight * LABEL_AGNOSTIC_PROPOSAL_POLICY.edgeInsetRatio;
  if (
    bbox.x1 < edgeInsetX ||
    bbox.y1 < edgeInsetY ||
    bbox.x2 > frameWidth - edgeInsetX ||
    bbox.y2 > frameHeight - edgeInsetY
  ) {
    return 'edge-proximity';
  }

  const centerRegion: DetectionBox = {
    x1: frameWidth * LABEL_AGNOSTIC_PROPOSAL_POLICY.centerMinimumXRatio,
    y1: frameHeight * LABEL_AGNOSTIC_PROPOSAL_POLICY.centerMinimumYRatio,
    x2: frameWidth * LABEL_AGNOSTIC_PROPOSAL_POLICY.centerMaximumXRatio,
    y2: frameHeight * LABEL_AGNOSTIC_PROPOSAL_POLICY.centerMaximumYRatio,
  };
  const centerX = (bbox.x1 + bbox.x2) / 2;
  const centerY = (bbox.y1 + bbox.y2) / 2;
  if (
    centerX < centerRegion.x1 ||
    centerX > centerRegion.x2 ||
    centerY < centerRegion.y1 ||
    centerY > centerRegion.y2
  ) {
    return 'center-outside';
  }

  if (
    intersectionArea(bbox, centerRegion) / area <
    LABEL_AGNOSTIC_PROPOSAL_POLICY.minimumCenterOverlapRatio
  ) {
    return 'center-overlap-low';
  }

  return null;
}

export function evaluateLabelAgnosticProposal(
  detections: DetectionCandidate[],
  frameWidth: number,
  frameHeight: number
): LabelAgnosticProposal {
  if (detections.length === 0) return { candidate: null, outcome: 'no-detections' };

  const ranked = [...detections].sort((left, right) => right.score - left.score);
  for (const candidate of ranked) {
    if (evaluateCandidate(candidate, frameWidth, frameHeight) === null) {
      return { candidate, outcome: 'accepted' };
    }
  }

  const candidate = ranked[0];
  return {
    candidate,
    outcome: evaluateCandidate(candidate, frameWidth, frameHeight) ?? 'invalid-box',
  };
}

export function evaluateInventoryCaptureProposal(
  detections: DetectionCandidate[],
  frameWidth: number,
  frameHeight: number
): LabelAgnosticProposal {
  return evaluateLabelAgnosticProposal(
    detections.filter(
      (detection) => !OBJECT_TRACKER_POLICY.excludedLabels.includes(detection.label)
    ),
    frameWidth,
    frameHeight
  );
}
