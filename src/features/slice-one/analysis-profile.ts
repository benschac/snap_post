export const ANALYSIS_TARGET_FPS_OPTIONS = [5, 10, 15] as const;

export type AnalysisTargetFps = (typeof ANALYSIS_TARGET_FPS_OPTIONS)[number];

export function analysisStride(targetFps: AnalysisTargetFps, cameraFps = 30) {
  return Math.max(1, Math.round(cameraFps / targetFps));
}
