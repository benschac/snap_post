export function summarizeCaptureLifecycle(
  completedItemCaptureCounts: number[],
  activeItemCaptureCount: number,
  activeItemFinalized: boolean
) {
  const completedSelectedPhotos = completedItemCaptureCounts.reduce(
    (total, captureCount) => total + captureCount,
    0
  );
  const activeSelectedPhotos = activeItemFinalized ? 0 : activeItemCaptureCount;

  return {
    activeSelectedPhotos,
    completedItems: completedItemCaptureCounts.length,
    selectedPhotos: completedSelectedPhotos + activeSelectedPhotos,
  };
}
