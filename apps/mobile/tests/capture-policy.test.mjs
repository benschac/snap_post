import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_POLICY,
  INITIAL_CAPTURE_POLICY_STATE,
  evaluateCapture,
  signatureDistance,
} from '../src/features/slice-one/capture-policy.ts';
import { analysisStride } from '../src/features/slice-one/analysis-profile.ts';
import {
  captureProposalGuidance,
  createDetectionOverlay,
  evaluateLabelAgnosticProposal,
  mapDetectionOverlayToPreview,
} from '../src/features/slice-one/label-agnostic-proposal.ts';
import {
  INITIAL_OBJECT_TRACKER_STATE,
  intersectionOverUnion,
  updateObjectTracker,
} from '../src/features/slice-one/object-tracker.ts';
import { analyzeBgraPixels } from '../src/features/slice-one/rgb-quality.ts';
import { computeScanGuideLayout } from '../src/features/slice-one/scan-guide-layout.ts';
import { summarizeCaptureLifecycle } from '../src/features/slice-one/session-summary.ts';

function sample(overrides = {}) {
  return {
    atMs: 2_000,
    brightness: 128,
    clippedRatio: 0.02,
    motion: 4,
    qualityScore: 0.8,
    sharpness: 24,
    signature: [30, 60, 90, 120],
    trackId: 'track-1',
    ...overrides,
  };
}

function assertApproximatelyEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should be approximately ${expected}`);
}

function stabilize(state, selected = []) {
  let nextState = state;
  for (let index = 1; index < CAPTURE_POLICY.stableFramesRequired; index += 1) {
    const result = evaluateCapture(nextState, sample({ atMs: 1_000 + index }), selected, false);
    assert.deepEqual(result.decision, { action: 'hold', reason: 'stabilizing' });
    nextState = result.state;
  }
  return nextState;
}

test('requires consecutive usable frames before capture', () => {
  const state = stabilize(INITIAL_CAPTURE_POLICY_STATE);
  const result = evaluateCapture(state, sample(), [], false);
  assert.deepEqual(result.decision, { action: 'capture' });
  assert.equal(result.state.stableFrames, 0);
});

test('resets stability after a poor frame', () => {
  const almostStable = stabilize(INITIAL_CAPTURE_POLICY_STATE);
  const rejected = evaluateCapture(almostStable, sample({ motion: 30 }), [], false);
  assert.deepEqual(rejected.decision, { action: 'hold', reason: 'quality' });
  assert.equal(rejected.state.stableFrames, 0);
});

test('uses the freed preview space when diagnostic panels are collapsed', () => {
  const guide = computeScanGuideLayout({
    previewHeight: 1_490,
    previewWidth: 690,
    topPanelBottom: 80,
    bottomPanelTop: 1_340,
  });

  assert.equal(guide.width, 630);
  assert.equal(guide.top, 237.5);
  assert.equal(guide.height, 945);
  assert.equal(guide.top + guide.height, 1_182.5);
});

test('maps detector proposal outcomes to concise framing guidance', () => {
  assert.equal(captureProposalGuidance('area-low'), 'Move closer');
  assert.equal(captureProposalGuidance('area-high'), 'Move farther away');
  assert.equal(captureProposalGuidance('center-outside'), 'Center the item');
  assert.equal(
    captureProposalGuidance('edge-proximity'),
    'Keep the whole item in frame'
  );
  assert.equal(captureProposalGuidance('no-detections'), 'Center one item');
});

test('creates an overlay only for a drawable detector proposal', () => {
  const accepted = evaluateLabelAgnosticProposal(
    [{ bbox: { x1: 200, y1: 100, x2: 440, y2: 260 }, label: 'book', score: 0.8 }],
    640,
    360
  );

  assert.deepEqual(createDetectionOverlay(accepted, 640, 360), {
    accepted: true,
    bbox: { x1: 200, y1: 100, x2: 440, y2: 260 },
    frameHeight: 360,
    frameWidth: 640,
  });
  assert.equal(
    createDetectionOverlay({ candidate: null, outcome: 'no-detections' }, 640, 360),
    null
  );
});

test('maps detector coordinates through preview aspect-fill crop and mirroring', () => {
  const overlay = {
    accepted: false,
    bbox: { x1: 100, y1: 200, x2: 300, y2: 600 },
    frameHeight: 1_280,
    frameWidth: 720,
  };

  const back = mapDetectionOverlayToPreview(overlay, 390, 844, false);
  const front = mapDetectionOverlayToPreview(overlay, 390, 844, true);

  assert.equal(back.color, '#F6C85F');
  assertApproximatelyEqual(back.height, 263.75);
  assertApproximatelyEqual(back.width, 131.875);
  assertApproximatelyEqual(back.x, 23.5625);
  assertApproximatelyEqual(back.y, 131.875);
  assert.equal(front.color, '#F6C85F');
  assertApproximatelyEqual(front.height, 263.75);
  assertApproximatelyEqual(front.width, 131.875);
  assertApproximatelyEqual(front.x, 234.5625);
  assertApproximatelyEqual(front.y, 131.875);
});

test('requires a visible object and restabilizes when the track changes', () => {
  const noObject = evaluateCapture(
    INITIAL_CAPTURE_POLICY_STATE,
    sample({ trackId: null }),
    [],
    false
  );
  assert.deepEqual(noObject.decision, { action: 'hold', reason: 'no-object' });

  const almostStable = stabilize(INITIAL_CAPTURE_POLICY_STATE);
  const changedTrack = evaluateCapture(
    almostStable,
    sample({ atMs: 2_000, trackId: 'track-2' }),
    [],
    false
  );
  assert.deepEqual(changedTrack.decision, { action: 'hold', reason: 'stabilizing' });
  assert.equal(changedTrack.state.stableFrames, 1);
  assert.equal(changedTrack.state.stableTrackId, 'track-2');
});

test('honors cooldown and rejects duplicate views', () => {
  const selected = [{ id: 'one', qualityScore: 0.7, signature: [30, 60, 90, 120] }];
  const cooldownState = stabilize({ lastCaptureAtMs: 1_500, stableFrames: 0 }, selected);
  const coolingDown = evaluateCapture(cooldownState, sample({ atMs: 2_000 }), selected, false);
  assert.deepEqual(coolingDown.decision, { action: 'hold', reason: 'cooldown' });

  const duplicateState = { ...cooldownState, lastCaptureAtMs: 0 };
  const duplicate = evaluateCapture(duplicateState, sample({ atMs: 3_000 }), selected, false);
  assert.deepEqual(duplicate.decision, { action: 'hold', reason: 'duplicate' });
  assert.equal(duplicate.state.stableFrames, 0);
  assert.equal(signatureDistance(selected[0].signature, sample().signature), 0);

  const reframed = evaluateCapture(
    duplicate.state,
    sample({ atMs: 3_200, signature: [45, 75, 105, 135] }),
    selected,
    false
  );
  assert.deepEqual(reframed.decision, { action: 'hold', reason: 'stabilizing' });
});

test('replaces only the weakest selected capture after a meaningful improvement', () => {
  const selected = [
    { id: 'weak', qualityScore: 0.62, signature: [10, 10, 10, 10] },
    { id: 'middle', qualityScore: 0.74, signature: [80, 80, 80, 80] },
    { id: 'strong', qualityScore: 0.9, signature: [160, 160, 160, 160] },
  ];
  const state = stabilize(INITIAL_CAPTURE_POLICY_STATE, selected);
  const result = evaluateCapture(state, sample({ qualityScore: 0.82 }), selected, false);
  assert.deepEqual(result.decision, { action: 'capture', replaceCaptureId: 'weak' });
});

test('does not capture while another photo is in flight', () => {
  const result = evaluateCapture(INITIAL_CAPTURE_POLICY_STATE, sample(), [], true);
  assert.deepEqual(result.decision, { action: 'hold', reason: 'busy' });
});

test('includes active item captures once in trace summaries', () => {
  assert.deepEqual(summarizeCaptureLifecycle([3, 2], 2, false), {
    activeSelectedPhotos: 2,
    completedItems: 2,
    selectedPhotos: 7,
  });
  assert.deepEqual(summarizeCaptureLifecycle([3, 2, 2], 2, true), {
    activeSelectedPhotos: 0,
    completedItems: 3,
    selectedPhotos: 7,
  });
});

test('keeps a track id for overlapping detections and changes it for a new object', () => {
  const first = updateObjectTracker(
    INITIAL_OBJECT_TRACKER_STATE,
    [{ bbox: { x1: 100, y1: 100, x2: 300, y2: 300 }, label: 'chair', score: 0.8 }],
    640,
    480
  );
  assert.equal(first.visibleTrack?.id, 'track-1');

  const overlapping = updateObjectTracker(
    first.state,
    [{ bbox: { x1: 110, y1: 105, x2: 305, y2: 295 }, label: 'chair', score: 0.78 }],
    640,
    480
  );
  assert.equal(overlapping.visibleTrack?.id, 'track-1');
  assert.ok(
    intersectionOverUnion(first.visibleTrack.bbox, overlapping.visibleTrack.bbox) > 0.8
  );

  const replacement = updateObjectTracker(
    overlapping.state,
    [{ bbox: { x1: 350, y1: 100, x2: 500, y2: 300 }, label: 'bottle', score: 0.9 }],
    640,
    480
  );
  assert.equal(replacement.visibleTrack?.id, 'track-2');
});

test('keeps a missing track only for reacquisition and never reports it as visible', () => {
  const first = updateObjectTracker(
    INITIAL_OBJECT_TRACKER_STATE,
    [{ bbox: { x1: 10, y1: 10, x2: 100, y2: 100 }, label: 'book', score: 0.75 }],
    320,
    240
  );
  const missing = updateObjectTracker(first.state, [], 320, 240);
  assert.equal(missing.visibleTrack, null);
  assert.equal(missing.state.current?.id, 'track-1');
});

test('maps the three benchmark profiles onto a 30 fps camera stream', () => {
  assert.equal(analysisStride(5), 6);
  assert.equal(analysisStride(10), 3);
  assert.equal(analysisStride(15), 2);
});

test('samples BGRA frames using their padded row stride', () => {
  const pixels = new Uint8Array([
    10, 20, 30, 255,
    10, 20, 30, 255,
    0, 0, 0, 0,
    10, 20, 30, 255,
    10, 20, 30, 255,
    0, 0, 0, 0,
  ]);
  const result = analyzeBgraPixels(pixels, 2, 2, 12, 2, 1);

  assert.equal(result.brightness, 21);
  assert.equal(result.clippedRatio, 0);
  assert.equal(result.sharpness, 0);
  assert.deepEqual(result.signature, [21]);
});
