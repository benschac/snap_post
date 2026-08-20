export type DetectionBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type DetectionCandidate = {
  bbox: DetectionBox;
  label: string;
  score: number;
};

export type ObjectTrack = DetectionCandidate & {
  id: string;
};

export type ObjectTrackerState = {
  current: ObjectTrack | null;
  missedFrames: number;
  nextTrackNumber: number;
};

export const OBJECT_TRACKER_POLICY = {
  matchIou: 0.25,
  maximumMissedFrames: 3,
  minimumScore: 0.5,
} as const;

export const INITIAL_OBJECT_TRACKER_STATE: ObjectTrackerState = {
  current: null,
  missedFrames: 0,
  nextTrackNumber: 1,
};

function boxArea(box: DetectionBox) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

export function intersectionOverUnion(left: DetectionBox, right: DetectionBox) {
  const intersection = boxArea({
    x1: Math.max(left.x1, right.x1),
    y1: Math.max(left.y1, right.y1),
    x2: Math.min(left.x2, right.x2),
    y2: Math.min(left.y2, right.y2),
  });
  if (intersection <= 0) return 0;

  const union = boxArea(left) + boxArea(right) - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectionRank(detection: DetectionCandidate, frameWidth: number, frameHeight: number) {
  const frameArea = Math.max(1, frameWidth * frameHeight);
  const areaScore = Math.min(1, boxArea(detection.bbox) / frameArea);
  const centerX = (detection.bbox.x1 + detection.bbox.x2) / 2;
  const centerY = (detection.bbox.y1 + detection.bbox.y2) / 2;
  const centerDistance = Math.hypot(
    (centerX - frameWidth / 2) / Math.max(1, frameWidth / 2),
    (centerY - frameHeight / 2) / Math.max(1, frameHeight / 2)
  );
  const centerScore = Math.max(0, 1 - centerDistance / Math.SQRT2);

  return detection.score * 0.7 + areaScore * 0.2 + centerScore * 0.1;
}

function isValidDetection(detection: DetectionCandidate) {
  return (
    Number.isFinite(detection.score) &&
    detection.score >= OBJECT_TRACKER_POLICY.minimumScore &&
    detection.label.length > 0 &&
    boxArea(detection.bbox) > 0
  );
}

function selectPrimaryDetection(
  detections: DetectionCandidate[],
  frameWidth: number,
  frameHeight: number
) {
  return detections
    .filter(isValidDetection)
    .sort(
      (left, right) =>
        detectionRank(right, frameWidth, frameHeight) -
        detectionRank(left, frameWidth, frameHeight)
    )[0];
}

export function updateObjectTracker(
  state: ObjectTrackerState,
  detections: DetectionCandidate[],
  frameWidth: number,
  frameHeight: number
): { state: ObjectTrackerState; visibleTrack: ObjectTrack | null } {
  const candidates = detections.filter(isValidDetection);
  const current = state.current;

  if (current) {
    const matchingDetection = candidates
      .filter((candidate) => candidate.label === current.label)
      .map((candidate) => ({
        candidate,
        iou: intersectionOverUnion(candidate.bbox, current.bbox),
      }))
      .filter(({ iou }) => iou >= OBJECT_TRACKER_POLICY.matchIou)
      .sort((left, right) => right.iou - left.iou || right.candidate.score - left.candidate.score)[0]
      ?.candidate;

    if (matchingDetection) {
      const visibleTrack = { ...matchingDetection, id: current.id };
      return {
        state: { ...state, current: visibleTrack, missedFrames: 0 },
        visibleTrack,
      };
    }
  }

  const primaryDetection = selectPrimaryDetection(candidates, frameWidth, frameHeight);
  if (primaryDetection) {
    const visibleTrack = {
      ...primaryDetection,
      id: `track-${state.nextTrackNumber}`,
    };
    return {
      state: {
        current: visibleTrack,
        missedFrames: 0,
        nextTrackNumber: state.nextTrackNumber + 1,
      },
      visibleTrack,
    };
  }

  const missedFrames = state.missedFrames + 1;
  return {
    state: {
      ...state,
      current:
        missedFrames > OBJECT_TRACKER_POLICY.maximumMissedFrames ? null : state.current,
      missedFrames,
    },
    visibleTrack: null,
  };
}
