import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import {
  type ControlContractClient,
  HealthResponseSchema,
  type HealthResponse,
  IdentifyErrorResponseSchema,
  IdentifyStreamEventSchema,
  type IdentifyStreamEvent,
  type IdentifyResponse,
} from '@snap/protocol';

const DEFAULT_TIMEOUT_MS = 5_000;
const IDENTIFY_TIMEOUT_MS = 15_000;

export type IdentifyRequestMetrics = {
  endToEndMs: number;
  firstEventMs: number;
  imageBytes: number;
  imageCount: number;
  providerLatencyMs: number;
  roundTripOverheadMs: number;
};

export type IdentifyItemImagesResult = {
  metrics: IdentifyRequestMetrics;
  response: IdentifyResponse;
};

export function resolveBackendUrl(
  configuredUrl = process.env.EXPO_PUBLIC_API_URL,
): string {
  if (!configuredUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not configured');
  }

  const url = new URL(configuredUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_API_URL must use http or https');
  }

  return url.toString().replace(/\/$/, '');
}

export function resolveControlSocketUrl(baseUrl = resolveBackendUrl()): string {
  const url = new URL('/v1/control', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function createControlClient(
  websocket: WebSocket,
): ControlContractClient {
  const link = new RPCLink({ websocket });
  return createORPCClient(link);
}

export async function fetchBackendHealth(options?: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (options?.fetchImpl ?? fetch)(
      new URL('/health', options?.baseUrl ?? resolveBackendUrl()),
      { signal: controller.signal },
    );

    if (!response.ok) {
      throw new Error(`Backend health check failed with ${response.status}`);
    }

    return HealthResponseSchema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function identifyItemImages(options: {
  sessionId: string;
  itemIntentId: string;
  imageId: string;
  images: Blob[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onEvent?: (event: IdentifyStreamEvent, elapsedMs: number) => void;
  timeoutMs?: number;
}): Promise<IdentifyItemImagesResult> {
  if (options.images.length === 0 || options.images.length > 3) {
    throw new Error('Identification requires between 1 and 3 images');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? IDENTIFY_TIMEOUT_MS,
  );
  const startedAt = performance.now();
  const formData = new FormData();
  options.images.forEach((image, index) => {
    formData.append('images', image, `view-${index + 1}.jpg`);
  });

  try {
    const response = await (options.fetchImpl ?? fetch)(
      new URL('/v1/identify', options.baseUrl ?? resolveBackendUrl()),
      {
        method: 'POST',
        headers: {
          'X-Snap-Session-Id': options.sessionId,
          'X-Snap-Item-Intent-Id': options.itemIntentId,
          'X-Snap-Image-Id': options.imageId,
        },
        body: formData,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const payload: unknown = await response.json();
      const failure = IdentifyErrorResponseSchema.safeParse(payload);
      throw new Error(
        failure.success
          ? failure.data.message
          : `Identification request failed with ${response.status}`,
      );
    }

    if (!response.body) {
      throw new Error('Identification response did not include a stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstEventMs: number | undefined;
    let result: IdentifyResponse | undefined;

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const event = IdentifyStreamEventSchema.parse(JSON.parse(line));
      const elapsedMs = performance.now() - startedAt;
      firstEventMs ??= elapsedMs;
      options.onEvent?.(event, elapsedMs);

      if (event.type === 'error') throw new Error(event.error.message);
      if (event.type === 'result') result = event.response;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          consumeLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
        }

        if (done) break;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }

    consumeLine(buffer);
    if (!result || firstEventMs === undefined) {
      throw new Error('Identification stream ended before a result was received');
    }

    const endToEndMs = performance.now() - startedAt;
    return {
      response: result,
      metrics: {
        endToEndMs,
        firstEventMs,
        imageBytes: options.images.reduce((total, image) => total + image.size, 0),
        imageCount: options.images.length,
        providerLatencyMs: result.provider.latencyMs,
        roundTripOverheadMs: Math.max(0, endToEndMs - result.provider.latencyMs),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
