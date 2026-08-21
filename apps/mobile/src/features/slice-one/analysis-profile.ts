export const ANALYSIS_TARGET_FPS_OPTIONS = [5, 10, 15] as const;

export type AnalysisTargetFps = (typeof ANALYSIS_TARGET_FPS_OPTIONS)[number];

export function analysisStride(targetFps: AnalysisTargetFps, cameraFps = 30) {
  'worklet';
  return Math.max(1, Math.round(cameraFps / targetFps));
}

export function analysisFrameId(timestamp: number, cameraFps = 30, secondsScale = 1) {
  'worklet';
  return Math.round(timestamp * secondsScale * cameraFps);
}

export function shouldAnalyzeFrame(
  timestamp: number,
  targetFps: AnalysisTargetFps,
  cameraFps = 30,
  secondsScale = 1
) {
  'worklet';
  return (
    analysisFrameId(timestamp, cameraFps, secondsScale) %
      analysisStride(targetFps, cameraFps) ===
    0
  );
}
