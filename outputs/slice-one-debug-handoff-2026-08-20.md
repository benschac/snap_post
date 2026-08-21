# Slice 1 capture debugging handoff — 2026-08-20

## Current conclusion

The VisionCamera analysis pipeline is keeping up. The remaining user-visible delay is primarily capture eligibility: the COCO object detector frequently produces no valid tracked object for arbitrary consumer products, with the motion gate as the secondary blocker. The diagnostic panels do not cover the native camera frames, but they did cover the visible scan guide and made centering and holding steady harder.

## Latest physical evidence

- Trace: `/Users/benjaminschachter/Downloads/slice-1-1787248172774-o7wpfi-diagnostic/trace.json`
- Preview bundle: `/Users/benjaminschachter/Downloads/slice-1-1787248172774-o7wpfi-diagnostic/previews/`
- UI screenshot: `/Users/benjaminschachter/Documents/SCR-20260820-mlyz.jpeg`
- Profile: 5 FPS target, 4.97 measured analysis FPS.
- Processing: zero analysis rejections, 48.2 ms gate p95, nominal thermal state, 43 dropped frames out of 3,085 input frames.
- Gate outcomes: 391/515 `no-object`, 69/515 quality failures, 28/515 stabilizing, and 9 captures.
- Quality failures: 55 motion and 14 sharpness.
- First-capture request latency by item: 2.1 s, 4.5 s, 23.5 s, 14.0 s, and 12.7 s.
- Five items produced nine retained photos; four items were advanced with fewer than three photos.
- The previews were generally usable, but the detector used incorrect proxy labels such as controller as `remote`/`cell_phone`, folio as `suitcase`, and vitamins as `remote`.

## Implemented local changes

1. Capture stability now requires two usable observations for the same track in a three-frame window. One bad or missing observation is tolerated; two misses expire the earlier observation.
2. `CAPTURE_POLICY.maximumMotion` is now 20 instead of 13. The existing minimum sharpness of 11 and minimum overall quality score of 0.56 remain in force.
3. The scan guide now measures the top and bottom diagnostic panels and stays between them with a 20-point gap, rather than calculating its height from the full screen and being covered by the bottom panel.
4. The visual pulse and success haptic now happen when the capture decision is accepted, before photo persistence.
5. New trace events distinguish haptic invocation:
   - `capture.haptic_requested`
   - `capture.haptic_dispatched`
   - `capture.haptic_error`

Owning files:

- `apps/mobile/src/features/slice-one/capture-policy.ts`
- `apps/mobile/src/features/slice-one/scan-guide-layout.ts`
- `apps/mobile/src/features/slice-zero/slice-zero-screen.tsx`
- `apps/mobile/tests/capture-policy.test.mjs`

The worktree contains substantial unrelated user work. Preserve it and keep any staging or edits limited to explicit files and hunks.

## Validation already completed

- Mobile tests: 24/24 passed.
- Workspace tests passed; the local database integration test was intentionally skipped.
- Workspace TypeScript checks passed.
- iOS Expo static export succeeded with 2,166 modules.
- Targeted `git diff --check` passed.
- `expo lint` is not currently usable because the repository has no ESLint configuration; Expo attempted first-time setup and hit its protected cache. No lint dependencies or configuration were added.

## Exact next test

No native rebuild is required. Use the installed development client connected to Metro, reload once, and keep the analysis profile at 5 FPS.

Test the same mix of ordinary consumer objects and record:

1. Whether the scan guide is fully visible between both diagnostic panels.
2. Whether the haptic and pulse feel immediate when a view is accepted.
3. Whether the selected-photo count updates shortly afterward.
4. Whether photographs accepted with motion between 13 and 20 remain sharp enough.
5. A diagnostic ZIP plus a screenshot of the running UI.

In the next trace, compare counts and ordering for:

- `capture.auto_requested`
- `capture.haptic_requested`
- `capture.haptic_dispatched`
- `capture.auto_saved`
- `capture.haptic_error`

Expected ordering is request -> haptic requested -> haptic dispatched -> photo saved. A dispatched event proves the native method was invoked, not that the physical vibration was perceptible.

## Decision after the next trace

- Keep the current policy if capture latency improves and the retained previews remain sharp.
- If `no-object` still dominates or ordinary items still take more than about 10 seconds, stop tuning FPS/stability. The next investigation should be detector suitability: detection threshold evidence, a generic objectness/foreground fallback, or a model better matched to arbitrary inventory items.
- Change one detector variable at a time; do not change FPS during the 5 FPS comparison run.

## Rebuild boundary

The current changes are JavaScript/TypeScript-only. Reloading the development client is sufficient. A native rebuild is needed only after changing native dependencies, app/native configuration, pods, Swift/Objective-C code, or the iOS project. An old standalone Release build will not load these local JavaScript changes from Metro.
