export type RgbQualityMetrics = {
  brightness: number;
  clippedRatio: number;
  sharpness: number;
  signature: number[];
};

export function analyzeBgraPixels(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  sampleSize = 64,
  signatureGridSize = 8
): RgbQualityMetrics {
  'worklet';

  if (
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    bytesPerRow < frameWidth * 4 ||
    pixels.byteLength < bytesPerRow * frameHeight ||
    sampleSize <= 0 ||
    signatureGridSize <= 0
  ) {
    throw new Error('Invalid BGRA frame geometry');
  }

  const samplePixels = sampleSize * sampleSize;
  const luminance = new Array<number>(samplePixels);
  const signature = new Array<number>(signatureGridSize * signatureGridSize).fill(0);
  const signatureCounts = new Array<number>(signature.length).fill(0);
  let luminanceSum = 0;
  let clippedPixels = 0;
  let edgeDifference = 0;
  let edgeCount = 0;

  for (let sampleY = 0; sampleY < sampleSize; sampleY += 1) {
    const sourceY = Math.min(
      frameHeight - 1,
      Math.floor(((sampleY + 0.5) * frameHeight) / sampleSize)
    );
    for (let sampleX = 0; sampleX < sampleSize; sampleX += 1) {
      const sourceX = Math.min(
        frameWidth - 1,
        Math.floor(((sampleX + 0.5) * frameWidth) / sampleSize)
      );
      const byteIndex = sourceY * bytesPerRow + sourceX * 4;
      const value =
        (29 * pixels[byteIndex] +
          150 * pixels[byteIndex + 1] +
          77 * pixels[byteIndex + 2]) >>
        8;
      const sampleIndex = sampleY * sampleSize + sampleX;
      luminance[sampleIndex] = value;
      luminanceSum += value;
      if (value <= 12 || value >= 243) clippedPixels += 1;

      if (sampleX > 0) {
        edgeDifference += Math.abs(value - luminance[sampleIndex - 1]);
        edgeCount += 1;
      }
      if (sampleY > 0) {
        edgeDifference += Math.abs(value - luminance[sampleIndex - sampleSize]);
        edgeCount += 1;
      }

      const signatureX = Math.min(
        signatureGridSize - 1,
        Math.floor((sampleX * signatureGridSize) / sampleSize)
      );
      const signatureY = Math.min(
        signatureGridSize - 1,
        Math.floor((sampleY * signatureGridSize) / sampleSize)
      );
      const signatureIndex = signatureY * signatureGridSize + signatureX;
      signature[signatureIndex] += value;
      signatureCounts[signatureIndex] += 1;
    }
  }

  for (let index = 0; index < signature.length; index += 1) {
    signature[index] =
      signatureCounts[index] > 0 ? signature[index] / signatureCounts[index] : 0;
  }

  return {
    brightness: luminanceSum / samplePixels,
    clippedRatio: clippedPixels / samplePixels,
    sharpness: edgeCount > 0 ? edgeDifference / edgeCount : 0,
    signature,
  };
}
