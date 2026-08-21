import { randomUUID } from 'node:crypto';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const DEFAULT_TIMEOUT_MS = 5_000;

export type ExaSearchErrorCode =
  | 'provider_unconfigured'
  | 'provider_timeout'
  | 'provider_error';

export class ExaSearchError extends Error {
  readonly code: ExaSearchErrorCode;

  constructor(code: ExaSearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExaSearchError';
    this.code = code;
  }
}

export type ExaSearchResult = {
  id: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
};

export type ExaSearchResponse = {
  requestId: string;
  latencyMs: number;
  results: ExaSearchResult[];
};

type ExaSearchOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSearchResult(value: unknown): ExaSearchResult | undefined {
  if (!isRecord(value)) return undefined;

  const url = optionalString(value.url);
  if (!url) return undefined;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const highlights = Array.isArray(value.highlights)
    ? value.highlights.filter(
        (highlight): highlight is string =>
          typeof highlight === 'string' && highlight.length > 0,
      )
    : [];

  return {
    id: optionalString(value.id) ?? url,
    title: optionalString(value.title) ?? new URL(url).hostname,
    url,
    publishedDate: optionalString(value.publishedDate),
    author: optionalString(value.author),
    highlights,
  };
}

export async function searchExa(
  query: string,
  options: ExaSearchOptions = {},
): Promise<ExaSearchResponse> {
  const apiKey = options.apiKey ?? process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new ExaSearchError(
      'provider_unconfigured',
      'EXA_API_KEY is not configured on the API server',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const startedAt = performance.now();

  try {
    const response = await (options.fetchImpl ?? fetch)(EXA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        type: 'instant',
        numResults: 4,
        userLocation: 'US',
        contents: {
          highlights: { maxCharacters: 300 },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ExaSearchError(
        'provider_error',
        `Exa search request failed with status ${response.status}`,
      );
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new ExaSearchError(
        'provider_error',
        'Exa search response did not contain results',
      );
    }

    return {
      requestId:
        optionalString(payload.requestId) ??
        response.headers.get('x-request-id') ??
        randomUUID(),
      latencyMs: performance.now() - startedAt,
      results: payload.results
        .map(readSearchResult)
        .filter((result): result is ExaSearchResult => result !== undefined),
    };
  } catch (error) {
    if (error instanceof ExaSearchError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ExaSearchError('provider_timeout', 'Exa search request timed out', {
        cause: error,
      });
    }
    throw new ExaSearchError('provider_error', 'Exa search request failed', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}
