export type ScanGuideLayoutInput = {
  bottomPanelTop: number;
  previewHeight: number;
  previewWidth: number;
  topPanelBottom: number;
};

export type ScanGuideLayout = {
  height: number;
  top: number;
  width: number;
};

const HORIZONTAL_INSET = 30;
const PANEL_GAP = 20;
const FALLBACK_TOP = 120;
const FALLBACK_BOTTOM_INSET = 240;
const MAX_PREVIEW_HEIGHT_RATIO = 0.65;
const MAX_GUIDE_ASPECT_RATIO = 1.5;

export function computeScanGuideLayout({
  bottomPanelTop,
  previewHeight,
  previewWidth,
  topPanelBottom,
}: ScanGuideLayoutInput): ScanGuideLayout {
  const width = Math.max(0, previewWidth - HORIZONTAL_INSET * 2);
  const safeTop = topPanelBottom > 0 ? topPanelBottom + PANEL_GAP : FALLBACK_TOP;
  const fallbackBottom = Math.max(safeTop, previewHeight - FALLBACK_BOTTOM_INSET);
  const safeBottom =
    bottomPanelTop > safeTop ? bottomPanelTop - PANEL_GAP : fallbackBottom;
  const availableHeight = Math.max(0, safeBottom - safeTop);
  const idealHeight = Math.min(
    previewHeight * MAX_PREVIEW_HEIGHT_RATIO,
    width * MAX_GUIDE_ASPECT_RATIO
  );
  const height = Math.max(0, Math.min(availableHeight, idealHeight));

  return {
    height,
    top: safeTop + Math.max(0, (availableHeight - height) / 2),
    width,
  };
}

export const SCAN_GUIDE_HORIZONTAL_INSET = HORIZONTAL_INSET;
