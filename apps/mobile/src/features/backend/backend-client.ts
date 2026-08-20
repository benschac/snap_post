import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import {
  type ControlContractClient,
  HealthResponseSchema,
  type HealthResponse,
} from '@snap/protocol';

const DEFAULT_TIMEOUT_MS = 5_000;

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
