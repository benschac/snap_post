import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_POLICY,
  INITIAL_CAPTURE_POLICY_STATE,
  captureQualityFailure,
  evaluateCapture,
  signatureDistance,
} from '../src/features/slice-one/capture-policy.ts';
import {
  analysisFrameId,
  analysisStride,
  shouldAnalyzeFrame,
} from '../src/features/slice-one/analysis-profile.ts';
import {
  beginCameraSwitch,
  markCameraSwitchConfigured,
  shouldCompleteCameraSwitch,
} from '../src/features/slice-one/camera-switch-lifecycle.ts';
import {
  captureProposalGuidance,
  createDetectionOverlay,
  evaluateInventoryCaptureProposal,
  evaluateLabelAgnosticProposal,
  mapDetectionOverlayToPreview,
  resolveObjectDetectionFrameSize,
} from '../src/features/slice-one/label-agnostic-proposal.ts';
import { createStoredZip } from '../src/features/slice-one/diagnostic-bundle.ts';
import {
  INITIAL_OBJECT_TRACKER_STATE,
  intersectionOverUnion,
  updateObjectTracker,
} from '../src/features/slice-one/object-tracker.ts';
import { analyzeBgraPixels } from '../src/features/slice-one/rgb-quality.ts';
import {
  resolveSalientObjectShadow,
  SALIENT_OBJECT_MAX_AGE_MS,
  selectCaptureTrack,
} from '../src/features/slice-one/salient-object-shadow.ts';
import {
  createCaptureItem,
  finalizeCaptureItem,
  replaceItemCaptures,
} from '../src/features/slice-one/item-session.ts';
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

test('captures after two usable observations for the same track', () => {
  const first = evaluateCapture(
    INITIAL_CAPTURE_POLICY_STATE,
    sample({ atMs: 1_000 }),
    [],
    false
  );
  const second = evaluateCapture(first.state, sample({ atMs: 1_200 }), [], false);

  assert.deepEqual(first.decision, { action: 'hold', reason: 'stabilizing' });
  assert.deepEqual(second.decision, { action: 'capture' });
  assert.equal(second.state.stableFrames, 0);
});

test('tolerates one poor observation inside the three-frame stability window', () => {
  const first = evaluateCapture(
    INITIAL_CAPTURE_POLICY_STATE,
    sample({ atMs: 1_000 }),
    [],
    false
  );
  const rejected = evaluateCapture(first.state, sample({ atMs: 1_200, motion: 30 }), [], false);
  assert.deepEqual(rejected.decision, { action: 'hold', reason: 'quality' });
  assert.equal(rejected.state.stableFrames, 0);

  const recovered = evaluateCapture(rejected.state, sample({ atMs: 1_400 }), [], false);
  assert.deepEqual(recovered.decision, { action: 'capture' });
});

test('expires an earlier usable observation after two misses', () => {
  const first = evaluateCapture(
    INITIAL_CAPTURE_POLICY_STATE,
    sample({ atMs: 1_000 }),
    [],
    false
  );
  const firstMiss = evaluateCapture(first.state, sample({ atMs: 1_200, trackId: null }), [], false);
  const secondMiss = evaluateCapture(
    firstMiss.state,
    sample({ atMs: 1_400, trackId: null }),
    [],
    false
  );
  const recovered = evaluateCapture(secondMiss.state, sample({ atMs: 1_600 }), [], false);

  assert.deepEqual(recovered.decision, { action: 'hold', reason: 'stabilizing' });
  assert.equal(recovered.state.stableFrames, 1);
});

test('reports the specific quality threshold that rejected a frame', () => {
  assert.equal(captureQualityFailure(sample({ motion: 30 })), 'motion');
  assert.equal(captureQualityFailure(sample({ motion: 20 })), null);
  assert.equal(captureQualityFailure(sample({ motion: 20.1 })), 'motion');
  assert.equal(captureQualityFailure(sample({ sharpness: 8 })), 'sharpness');
  assert.equal(captureQualityFailure(sample()), null);
});

test('accepts moderately moving frames when sharpness remains usable', () => {
  const first = evaluateCapture(
    INITIAL_CAPTURE_POLICY_STATE,
    sample({ atMs: 1_000, motion: 18, sharpness: 13 }),
    [],
    false
  );
  const second = evaluateCapture(
    first.state,
    sample({ atMs: 1_200, motion: 18, sharpness: 13 }),
    [],
    false
  );

  assert.deepEqual(second.decision, { action: 'capture' });
});

test('keeps the scan guide between measured diagnostic panels', () => {
  const guide = computeScanGuideLayout({
    previewHeight: 1_490,
    previewWidth: 690,
    topPanelBottom: 350,
    bottomPanelTop: 925,
  });

  assert.equal(guide.width, 630);
  assert.equal(guide.top, 370);
  assert.equal(guide.height, 535);
  assert.equal(guide.top + guide.height, 905);
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

test('completes a camera switch only from the requested device after configuration', () => {
  const requested = beginCameraSwitch('front-device', 'front', 1_000);
  const wrongDevice = markCameraSwitchConfigured(requested, 'back-device', 1_100);
  const configured = markCameraSwitchConfigured(wrongDevice, 'front-device', 1_200);

  assert.equal(wrongDevice?.configuredAtMs, null);
  assert.equal(shouldCompleteCameraSwitch(configured, 1_199), false);
  assert.equal(shouldCompleteCameraSwitch(configured, 1_200), true);
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
  const cooldownState = stabilize(
    { ...INITIAL_CAPTURE_POLICY_STATE, lastCaptureAtMs: 1_500 },
    selected
  );
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

test('keeps the track id when an overlapping object label changes', () => {
  const first = updateObjectTracker(
    INITIAL_OBJECT_TRACKER_STATE,
    [{ bbox: { x1: 100, y1: 100, x2: 300, y2: 300 }, label: 'laptop', score: 0.8 }],
    640,
    480
  );
  const relabeled = updateObjectTracker(
    first.state,
    [{ bbox: { x1: 105, y1: 100, x2: 305, y2: 300 }, label: 'keyboard', score: 0.82 }],
    640,
    480
  );

  assert.equal(relabeled.visibleTrack?.id, 'track-1');
  assert.equal(relabeled.visibleTrack?.label, 'keyboard');
});

test('does not expose a person as an inventory capture track', () => {
  const result = updateObjectTracker(
    INITIAL_OBJECT_TRACKER_STATE,
    [
      { bbox: { x1: 20, y1: 20, x2: 620, y2: 460 }, label: 'person', score: 0.99 },
      { bbox: { x1: 180, y1: 160, x2: 420, y2: 360 }, label: 'keyboard', score: 0.72 },
    ],
    640,
    480
  );

  assert.equal(result.visibleTrack?.label, 'keyboard');
  assert.equal(result.visibleTrack?.id, 'track-1');
});

test('rejects background geometry before an inventory detection reaches the tracker', () => {
  const fullFrame = evaluateInventoryCaptureProposal(
    [
      {
        bbox: { x1: 9, y1: 14, x2: 712, y2: 1268 },
        label: 'dining_table',
        score: 0.68,
      },
    ],
    720,
    1280
  );
  const edgeOnly = evaluateInventoryCaptureProposal(
    [{ bbox: { x1: 5, y1: 24, x2: 230, y2: 535 }, label: 'toilet', score: 0.91 }],
    720,
    1280
  );

  assert.equal(fullFrame.outcome, 'area-high');
  assert.equal(edgeOnly.outcome, 'edge-proximity');
});

test('ignores person labels while retaining a centered inventory proposal', () => {
  const result = evaluateInventoryCaptureProposal(
    [
      { bbox: { x1: 150, y1: 180, x2: 570, y2: 1_050 }, label: 'person', score: 0.99 },
      { bbox: { x1: 280, y1: 420, x2: 530, y2: 790 }, label: 'remote', score: 0.83 },
    ],
    720,
    1280
  );

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.candidate?.label, 'remote');
});

test('evaluates detector boxes in screen space instead of raw sensor-frame space', () => {
  const detectionFrameSize = resolveObjectDetectionFrameSize(1_280, 720);
  const result = evaluateInventoryCaptureProposal(
    [
      {
        bbox: { x1: 169.7, y1: 401.5, x2: 619.9, y2: 749.5 },
        label: 'remote',
        score: 0.981,
      },
      {
        bbox: { x1: 9, y1: 869.5, x2: 718.9, y2: 1_272 },
        label: 'person',
        score: 0.702,
      },
    ],
    detectionFrameSize.width,
    detectionFrameSize.height
  );

  assert.deepEqual(detectionFrameSize, { width: 720, height: 1_280 });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.candidate?.label, 'remote');
});

test('accepts a centered label-agnostic proposal without trusting its label', () => {
  const result = evaluateLabelAgnosticProposal(
    [
      {
        bbox: { x1: 200, y1: 100, x2: 440, y2: 260 },
        label: 'person',
        score: 0.81,
      },
    ],
    640,
    360
  );

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.candidate?.label, 'person');
});

test('rejects full-frame and edge-bound label-agnostic proposals', () => {
  const fullFrame = evaluateLabelAgnosticProposal(
    [{ bbox: { x1: 0, y1: 0, x2: 640, y2: 360 }, label: 'person', score: 0.99 }],
    640,
    360
  );
  const edgeBound = evaluateLabelAgnosticProposal(
    [{ bbox: { x1: 0, y1: 90, x2: 280, y2: 270 }, label: 'person', score: 0.9 }],
    640,
    360
  );

  assert.equal(fullFrame.outcome, 'area-high');
  assert.equal(edgeBound.outcome, 'edge-proximity');
});

test('selects the highest-confidence valid proposal across labels', () => {
  const result = evaluateLabelAgnosticProposal(
    [
      { bbox: { x1: 0, y1: 0, x2: 640, y2: 360 }, label: 'person', score: 0.99 },
      { bbox: { x1: 220, y1: 100, x2: 420, y2: 250 }, label: 'remote', score: 0.72 },
      { bbox: { x1: 210, y1: 95, x2: 430, y2: 255 }, label: 'book', score: 0.68 },
    ],
    640,
    360
  );

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.candidate?.label, 'remote');
});

test('applies label-agnostic proposal geometry proportionally across resolutions', () => {
  const full = evaluateLabelAgnosticProposal(
    [{ bbox: { x1: 200, y1: 100, x2: 440, y2: 260 }, label: 'person', score: 0.8 }],
    640,
    360
  );
  const half = evaluateLabelAgnosticProposal(
    [{ bbox: { x1: 100, y1: 50, x2: 220, y2: 130 }, label: 'person', score: 0.8 }],
    320,
    180
  );

  assert.equal(full.outcome, 'accepted');
  assert.equal(half.outcome, 'accepted');
});

test('reports why a label-agnostic proposal failed its geometry gate', () => {
  const cases = [
    {
      detection: { bbox: { x1: 280, y1: 150, x2: 340, y2: 210 }, label: 'person', score: 0.8 },
      expected: 'area-low',
    },
    {
      detection: { bbox: { x1: 20, y1: 100, x2: 160, y2: 250 }, label: 'person', score: 0.8 },
      expected: 'center-outside',
    },
    {
      detection: { bbox: { x1: 20, y1: 80, x2: 300, y2: 280 }, label: 'person', score: 0.8 },
      expected: 'center-overlap-low',
    },
    {
      detection: { bbox: { x1: 200, y1: 100, x2: 440, y2: 260 }, label: 'person', score: 0.4 },
      expected: 'score-low',
    },
    {
      detection: { bbox: { x1: 300, y1: 100, x2: 200, y2: 260 }, label: 'person', score: 0.8 },
      expected: 'invalid-box',
    },
  ];

  for (const { detection, expected } of cases) {
    const result = evaluateLabelAgnosticProposal([detection], 640, 360);
    assert.equal(result.outcome, expected);
  }
});

test('converts a fresh normalized salient object into frame coordinates', () => {
  const result = resolveSalientObjectShadow(
    {
      boxes: [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }],
      receivedAtMs: 1_000,
    },
    1_100,
    720,
    1280
  );

  assert.equal(result.freshness, 'fresh');
  assert.equal(result.ageMs, 100);
  assert.deepEqual(result.detections, [
    {
      bbox: { x1: 180, y1: 320, x2: 540, y2: 960 },
      label: 'salient-object',
      score: 1,
    },
  ]);
});

test('uses a namespaced salient track only when the inventory detector has none', () => {
  const inventoryTrack = {
    bbox: { x1: 180, y1: 120, x2: 460, y2: 300 },
    id: 'track-4',
    label: 'remote',
    score: 0.72,
  };
  const salientObjectTrack = {
    bbox: { x1: 200, y1: 100, x2: 440, y2: 260 },
    id: 'track-1',
    label: 'salient-object',
    score: 1,
  };

  assert.deepEqual(selectCaptureTrack(inventoryTrack, salientObjectTrack), {
    source: 'inventory-detector',
    track: inventoryTrack,
  });
  assert.deepEqual(selectCaptureTrack(null, salientObjectTrack), {
    source: 'salient-object',
    track: { ...salientObjectTrack, id: 'salient-track-1' },
  });
  assert.deepEqual(selectCaptureTrack(null, null), { source: 'none', track: null });
});

test('accepts a centered salient object and rejects a background-sized one', () => {
  const centered = evaluateLabelAgnosticProposal(
    [
      {
        bbox: { x1: 361, y1: 178.6, x2: 801.3, y2: 584.5 },
        label: 'salient-object',
        score: 1,
      },
    ],
    1_280,
    720
  );
  const background = evaluateLabelAgnosticProposal(
    [
      {
        bbox: { x1: 320, y1: 13.6, x2: 1_278.7, y2: 705.5 },
        label: 'salient-object',
        score: 1,
      },
    ],
    1_280,
    720
  );

  assert.equal(centered.outcome, 'accepted');
  assert.equal(background.outcome, 'area-high');
});

test('does not reuse a stale salient object observation', () => {
  const result = resolveSalientObjectShadow(
    {
      boxes: [{ x: 0.25, y: 0.2, width: 0.5, height: 0.4 }],
      receivedAtMs: 1_000,
    },
    1_000 + SALIENT_OBJECT_MAX_AGE_MS + 1,
    720,
    1280
  );

  assert.equal(result.freshness, 'stale');
  assert.deepEqual(result.detections, []);
});

test('distinguishes a missing salient callback from a fresh empty observation', () => {
  const missing = resolveSalientObjectShadow(null, 1_000, 720, 1280);
  const empty = resolveSalientObjectShadow(
    { boxes: [], receivedAtMs: 900 },
    1_000,
    720,
    1280
  );

  assert.equal(missing.freshness, 'missing');
  assert.equal(empty.freshness, 'fresh');
  assert.deepEqual(empty.detections, []);
});

test('rejects invalid salient object geometry', () => {
  const result = resolveSalientObjectShadow(
    {
      boxes: [{ x: 0.8, y: 0.2, width: 0.3, height: 0.4 }],
      receivedAtMs: 1_000,
    },
    1_100,
    720,
    1280
  );

  assert.equal(result.freshness, 'fresh');
  assert.deepEqual(result.detections, []);
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

test('finalizes zero-photo items and keeps late captures on the closed item', () => {
  const item = createCaptureItem(1);
  finalizeCaptureItem(item);
  const nextItem = createCaptureItem(2);

  assert.equal(item.finalized, true);
  assert.equal(item.needsReview, true);
  assert.deepEqual(item.captures, []);

  replaceItemCaptures(item, [
    { id: 'one' },
    { id: 'two' },
    { id: 'three' },
  ]);
  assert.deepEqual(item.captures.map((capture) => capture.id), ['one', 'two', 'three']);
  assert.equal(item.needsReview, false);
  assert.deepEqual(nextItem.captures, []);
});

test('maps the three benchmark profiles onto a 30 fps camera stream', () => {
  assert.equal(analysisStride(5), 6);
  assert.equal(analysisStride(10), 3);
  assert.equal(analysisStride(15), 2);
});

test('selects five unique analysis frames per second from native timestamps', () => {
  const iosTimestamps = Array.from({ length: 60 }, (_, index) => 100 + index / 30);
  const androidTimestamps = iosTimestamps.map((timestamp) => timestamp * 1_000_000_000);

  const iosIds = iosTimestamps
    .filter((timestamp) => shouldAnalyzeFrame(timestamp, 5, 30, 1))
    .map((timestamp) => analysisFrameId(timestamp, 30, 1));
  const androidIds = androidTimestamps
    .filter((timestamp) => shouldAnalyzeFrame(timestamp, 5, 30, 1 / 1_000_000_000))
    .map((timestamp) => analysisFrameId(timestamp, 30, 1 / 1_000_000_000));

  assert.equal(iosIds.length, 10);
  assert.equal(new Set(iosIds).size, iosIds.length);
  assert.deepEqual(androidIds, iosIds);
});

test('builds a ZIP containing the trace and retained preview paths', () => {
  const encoder = new TextEncoder();
  const zip = createStoredZip([
    { name: 'trace.json', bytes: encoder.encode('{"slice":1}') },
    { name: 'previews/item-001/capture.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
  ]);
  const decoded = new TextDecoder('latin1').decode(zip);

  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.match(decoded, /trace\.json/);
  assert.match(decoded, /previews\/item-001\/capture\.jpg/);
  assert.deepEqual(Array.from(zip.slice(-22, -18)), [0x50, 0x4b, 0x05, 0x06]);
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
