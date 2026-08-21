import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { computeScanGuideLayout } from '../slice-one/scan-guide-layout';

export function useScanGuideLayout() {
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [topPanelBottom, setTopPanelBottom] = useState(0);
  const [bottomPanelTop, setBottomPanelTop] = useState(0);

  const onPreviewLayout = useCallback((event: LayoutChangeEvent) => {
    setPreviewSize(event.nativeEvent.layout);
  }, []);
  const onTopPanelLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, y } = event.nativeEvent.layout;
    setTopPanelBottom(y + height);
  }, []);
  const onBottomPanelLayout = useCallback((event: LayoutChangeEvent) => {
    setBottomPanelTop(event.nativeEvent.layout.y);
  }, []);

  const scanGuide = computeScanGuideLayout({
    bottomPanelTop,
    previewHeight: previewSize.height,
    previewWidth: previewSize.width,
    topPanelBottom,
  });

  return {
    onBottomPanelLayout,
    onPreviewLayout,
    onTopPanelLayout,
    previewSize,
    scanGuide,
  };
}
