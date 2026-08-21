export type CaptureItem<TCapture> = {
  itemIndex: number;
  captures: TCapture[];
  finalized: boolean;
  needsReview: boolean;
};

export function createCaptureItem<TCapture>(itemIndex: number): CaptureItem<TCapture> {
  return {
    itemIndex,
    captures: [],
    finalized: false,
    needsReview: true,
  };
}

export function finalizeCaptureItem<TCapture>(item: CaptureItem<TCapture>) {
  item.finalized = true;
  item.needsReview = item.captures.length < 3;
  return item;
}

export function replaceItemCaptures<TCapture>(
  item: CaptureItem<TCapture>,
  captures: TCapture[]
) {
  item.captures = captures;
  item.needsReview = captures.length < 3;
  return item;
}
