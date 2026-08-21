import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  identifyVisualItem,
  MAX_INPUT_IMAGES,
} from '../src/providers/visual-identity.ts';

const DEFAULT_MODELS = [
  'google/gemini-3.7-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite',
];

const imagePaths = process.argv.slice(2);
if (imagePaths.length === 0 || imagePaths.length > MAX_INPUT_IMAGES) {
  console.error(
    `Usage: pnpm --filter @snap/api benchmark:identity <view-1.jpg> [view-2.jpg] [view-3.jpg]`,
  );
  process.exitCode = 1;
} else if (imagePaths.some((imagePath) => !['.jpg', '.jpeg'].includes(extname(imagePath).toLowerCase()))) {
  console.error('Every benchmark input must be a JPEG file');
  process.exitCode = 1;
} else {
  const images = await Promise.all(
    imagePaths.map(async (imagePath) => ({
      contentType: 'image/jpeg' as const,
      imageBytes: new Uint8Array(await readFile(imagePath)),
    })),
  );
  const configuredModels = process.env.IDENTITY_BENCHMARK_MODELS
    ?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configuredModels?.length ? configuredModels : DEFAULT_MODELS;

  for (const model of models) {
    try {
      const startedAt = performance.now();
      let observedPartialLatencyMs: number | undefined;
      const result = await identifyVisualItem(
        { images },
        {
          model,
          onPartialInference: () => {
            observedPartialLatencyMs ??= performance.now() - startedAt;
          },
        },
      );
      console.log(JSON.stringify({
        status: 'ok',
        observedPartialLatencyMs,
        ...result,
      }));
    } catch (error) {
      console.log(JSON.stringify({
        status: 'error',
        model,
        error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    }
  }
}
