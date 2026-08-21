import { upgradeWebSocket } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import {
  CONTROL_PROTOCOL_VERSION,
  EvidencePatchEventSchema,
  HealthResponseSchema,
  IdentityCandidateEventSchema,
  IdentifyErrorResponseSchema,
  IdentifyRequestMetadataSchema,
  IdentifyResponseSchema,
  IdentifyStreamAcceptedSchema,
  IdentifyStreamErrorSchema,
  IdentifyStreamResultSchema,
  TaskFailedEventSchema,
} from '@snap/protocol';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';

import {
  ExaSearchError,
  searchExa,
  type ExaSearchResponse,
} from './providers/exa-search.ts';
import {
  identifyVisualItem,
  VisualIdentityError,
  type VisualIdentityOptions,
  type VisualIdentityResult,
} from './providers/visual-identity.ts';
import {
  ProviderBudgetError,
  ProviderRequestBudget,
} from './providers/provider-budget.ts';
import { ServerEventBroker } from './server-events.ts';

const MAX_IDENTIFICATION_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IDENTIFICATION_IMAGES = 3;

export type IdentifyImage = (
  input: {
    images: Array<{
      contentType: 'image/jpeg';
      imageBytes: Uint8Array;
    }>;
  },
  options?: Pick<VisualIdentityOptions, 'onPartialInference'>,
) => Promise<VisualIdentityResult>;

export type SearchEvidence = (query: string) => Promise<ExaSearchResponse>;

export type BackendLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  details?: Record<string, unknown>,
) => void;

export type ApiAppOptions = {
  evidenceBudget?: ProviderRequestBudget;
  identifyImage?: IdentifyImage;
  logger?: BackendLogger;
  providerBudget?: ProviderRequestBudget;
  searchEvidence?: SearchEvidence;
  serverEvents?: ServerEventBroker;
};

const consoleBackendLogger: BackendLogger = (level, event, details = {}) => {
  const message = JSON.stringify({
    ...details,
    at: new Date().toISOString(),
    level,
    event,
  });

  if (level === 'error') {
    console.error(`[snap-api] ${message}`);
    return;
  }
  if (level === 'warn') {
    console.warn(`[snap-api] ${message}`);
    return;
  }
  console.info(`[snap-api] ${message}`);
};

function nullableValue(value: string | null): string | undefined {
  return value ?? undefined;
}

function evidenceSearchQuery(inference: VisualIdentityResult['inference']) {
  if (!inference.searchQuery) return undefined;
  return inference.alternative
    ? `${inference.searchQuery} vs ${inference.alternative}`
    : inference.searchQuery;
}

function identifyError(error: unknown) {
  if (error instanceof VisualIdentityError) {
    return IdentifyErrorResponseSchema.parse({
      error: error.code,
      message: error.message,
    });
  }

  return IdentifyErrorResponseSchema.parse({
    error: 'provider_error',
    message: error instanceof Error ? error.message : 'Identification provider failed',
  });
}

function ndjson(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function evidenceValue(result: ExaSearchResponse['results'][number]) {
  return {
    title: result.title,
    url: result.url,
    ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
    ...(result.author ? { author: result.author } : {}),
    highlights: result.highlights,
  };
}

async function publishEvidenceSearch(options: {
  budget: ProviderRequestBudget;
  itemIntentId: string;
  logger: BackendLogger;
  query: string;
  searchEvidence: SearchEvidence;
  serverEvents: ServerEventBroker;
  sessionId: string;
}) {
  let releaseBudget: (() => void) | undefined;
  try {
    releaseBudget = options.budget.acquire(options.sessionId);
    options.logger('info', 'exa.request_started', {
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      query: options.query.slice(0, 200),
    });
    const result = await options.searchEvidence(options.query);
    options.logger('info', 'exa.request_completed', {
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      providerRequestId: result.requestId,
      latencyMs: Math.round(result.latencyMs),
      resultCount: result.results.length,
    });
    if (result.results.length === 0) {
      options.logger('warn', 'evidence.not_published', {
        sessionId: options.sessionId,
        itemIntentId: options.itemIntentId,
        reason: 'no_exa_results',
      });
      return;
    }

    const observedAt = new Date().toISOString();
    const evidenceEvent = EvidencePatchEventSchema.parse({
      type: 'evidence.patch',
      eventId: randomUUID(),
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      revision: options.serverEvents.nextRevision(options.sessionId),
      schemaVersion: CONTROL_PROTOCOL_VERSION,
      serverTimestamp: observedAt,
      payload: {
        claims: [
          {
            path: 'web.candidates',
            value: result.results.map(evidenceValue),
            status: 'inferred',
            confidence: 0.5,
            provenance: result.results.map((candidate) => ({
              sourceId: candidate.id,
              sourceType: 'provider',
              url: candidate.url,
              observedAt,
            })),
          },
        ],
        provider: {
          name: 'exa',
          requestId: result.requestId,
          latencyMs: result.latencyMs,
        },
      },
    });
    options.serverEvents.publish(evidenceEvent);
    options.logger('info', 'evidence.event_published', {
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      revision: evidenceEvent.revision,
      resultCount: result.results.length,
    });
  } catch (error) {
    const code =
      error instanceof ExaSearchError || error instanceof ProviderBudgetError
        ? error.code
        : 'provider_error';
    const message = error instanceof Error ? error.message : 'Exa evidence search failed';
    options.logger('error', 'exa.request_failed', {
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      code,
      message,
    });
    const failureEvent = TaskFailedEventSchema.parse({
      type: 'task.failed',
      eventId: randomUUID(),
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      revision: options.serverEvents.nextRevision(options.sessionId),
      schemaVersion: CONTROL_PROTOCOL_VERSION,
      serverTimestamp: new Date().toISOString(),
      payload: {
        taskId: `${options.itemIntentId}:exa`,
        code,
        message,
        retryable: code !== 'provider_unconfigured' && code !== 'session_request_limit',
      },
    });
    options.serverEvents.publish(failureEvent);
    options.logger('warn', 'task_failed.event_published', {
      sessionId: options.sessionId,
      itemIntentId: options.itemIntentId,
      revision: failureEvent.revision,
      code,
    });
  } finally {
    releaseBudget?.();
  }
}

export function createApiApp(options: ApiAppOptions = {}) {
  const app = new Hono();
  const identifyImage = options.identifyImage ?? identifyVisualItem;
  const logger = options.logger ?? consoleBackendLogger;
  const searchEvidence = options.searchEvidence ?? searchExa;
  const serverEvents = options.serverEvents ?? new ServerEventBroker();
  const providerBudget =
    options.providerBudget ??
    new ProviderRequestBudget({
      maxConcurrentRequests: 2,
      maxRequestsPerSession: 20,
    });
  const evidenceBudget =
    options.evidenceBudget ??
    new ProviderRequestBudget({
      maxConcurrentRequests: 4,
      maxRequestsPerSession: 20,
    });

  app.get('/health', (context) =>
    context.json(
      HealthResponseSchema.parse({
        service: 'snap-api',
        status: 'ok',
        protocolVersion: CONTROL_PROTOCOL_VERSION,
      }),
    ),
  );

  app.post('/v1/identify', async (context) => {
    const metadata = IdentifyRequestMetadataSchema.safeParse({
      sessionId: context.req.header('x-snap-session-id'),
      itemIntentId: context.req.header('x-snap-item-intent-id'),
      imageId: context.req.header('x-snap-image-id'),
    });
    if (!metadata.success) {
      logger('warn', 'identify.request_rejected', { reason: 'missing_metadata' });
      return context.json(
        { error: 'invalid_request', message: 'Missing identification request metadata' },
        400,
      );
    }

    const contentType = context.req.header('content-type')?.split(';', 1)[0];
    if (contentType !== 'image/jpeg' && contentType !== 'multipart/form-data') {
      logger('warn', 'identify.request_rejected', {
        ...metadata.data,
        reason: 'invalid_content_type',
        contentType: contentType ?? null,
      });
      return context.json(
        {
          error: 'invalid_request',
          message: 'Identification input must be image/jpeg or multipart/form-data',
        },
        400,
      );
    }

    let images: Array<{ contentType: 'image/jpeg'; imageBytes: Uint8Array }>;
    if (contentType === 'image/jpeg') {
      images = [
        {
          contentType,
          imageBytes: new Uint8Array(await context.req.arrayBuffer()),
        },
      ];
    } else {
      const formData = await context.req.formData();
      const imageParts = formData.getAll('images');
      if (
        imageParts.length === 0 ||
        imageParts.length > MAX_IDENTIFICATION_IMAGES ||
        imageParts.some(
          (part) => !(part instanceof Blob) || part.type !== 'image/jpeg',
        )
      ) {
        logger('warn', 'identify.request_rejected', {
          ...metadata.data,
          reason: 'invalid_image_parts',
          imageCount: imageParts.length,
        });
        return context.json(
          {
            error: 'invalid_request',
            message: `Identification requires 1 to ${MAX_IDENTIFICATION_IMAGES} JPEG images`,
          },
          400,
        );
      }
      images = await Promise.all(
        imageParts.map(async (part) => ({
          contentType: 'image/jpeg' as const,
          imageBytes: new Uint8Array(await (part as Blob).arrayBuffer()),
        })),
      );
    }

    const imageByteLengths = images.map((image) => image.imageBytes.byteLength);
    const imageBytes = imageByteLengths.reduce((total, byteLength) => total + byteLength, 0);
    if (imageByteLengths.some((byteLength) => byteLength === 0)) {
      logger('warn', 'identify.request_rejected', {
        ...metadata.data,
        reason: 'empty_image',
        imageByteLengths,
      });
      return context.json(
        { error: 'invalid_request', message: 'Identification image is empty' },
        400,
      );
    }
    if (
      imageByteLengths.some(
        (byteLength) => byteLength > MAX_IDENTIFICATION_IMAGE_BYTES,
      )
    ) {
      logger('warn', 'identify.request_rejected', {
        ...metadata.data,
        reason: 'image_too_large',
        imageByteLengths,
      });
      return context.json(
        { error: 'image_too_large', message: 'An identification image exceeds 2 MB' },
        413,
      );
    }

    let releaseBudget: (() => void) | undefined;
    try {
      releaseBudget = providerBudget.acquire(metadata.data.sessionId);
    } catch (error) {
      if (error instanceof ProviderBudgetError) {
        logger('warn', 'identify.request_rejected', {
          ...metadata.data,
          reason: error.code,
        });
        return context.json({ error: error.code, message: error.message }, 429);
      }
      throw error;
    }

    context.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    context.header('Cache-Control', 'no-store, no-transform');
    context.header('X-Accel-Buffering', 'no');
    logger('info', 'identify.request_received', {
      ...metadata.data,
      imageBytes,
      imageByteLengths,
      imageCount: images.length,
    });

    return stream(context, async (responseStream) => {
      try {
        await responseStream.write(
          ndjson(
            IdentifyStreamAcceptedSchema.parse({
              type: 'accepted',
              acceptedAt: new Date().toISOString(),
              request: metadata.data,
            }),
          ),
        );
        logger('info', 'identify.request_accepted', metadata.data);
        logger('info', 'identity_provider.request_started', {
          ...metadata.data,
          imageBytes,
          imageByteLengths,
          imageCount: images.length,
        });

        const publishIdentityCandidate = (
          inference: VisualIdentityResult['inference'],
          sourceId: string,
        ) => {
          const identityEvent = IdentityCandidateEventSchema.parse({
            type: 'identity.candidate',
            eventId: randomUUID(),
            sessionId: metadata.data.sessionId,
            itemIntentId: metadata.data.itemIntentId,
            revision: serverEvents.nextRevision(metadata.data.sessionId),
            schemaVersion: CONTROL_PROTOCOL_VERSION,
            serverTimestamp: new Date().toISOString(),
            payload: {
              candidateId: `${metadata.data.itemIntentId}:${metadata.data.imageId}:visual-identity`,
              level: inference.level,
              category: inference.category,
              brand: nullableValue(inference.brand),
              productName: nullableValue(inference.productName),
              model: nullableValue(inference.model),
              variant: nullableValue(inference.variant),
              confidence: inference.confidence,
              provenance: [{ sourceId, sourceType: 'provider' }],
            },
          });
          serverEvents.publish(identityEvent);
          logger('info', 'identity.event_published', {
            ...metadata.data,
            revision: identityEvent.revision,
            partial: sourceId.endsWith(':stream'),
          });
          return identityEvent;
        };

        const result = await identifyImage(
          { images },
          {
            onPartialInference: (inference) => {
              publishIdentityCandidate(
                inference,
                `${metadata.data.itemIntentId}:visual-identity:stream`,
              );
            },
          },
        );
        const { inference } = result;
        logger('info', 'identity_provider.request_completed', {
          ...metadata.data,
          providerRequestId: result.requestId,
          model: result.model,
          latencyMs: Math.round(result.latencyMs),
          identityLevel: inference.level,
          category: inference.category,
          brand: inference.brand,
          productName: inference.productName,
          modelName: inference.model,
          reportedConfidence: result.reportedConfidence ?? inference.confidence,
          confidence: inference.confidence,
          visualEvidence: inference.visualEvidence ?? [],
          alternative: inference.alternative ?? null,
          imageCount: images.length,
        });
        const searchQuery = evidenceSearchQuery(inference);
        const response = IdentifyResponseSchema.parse({
          requestId: result.requestId,
          ...metadata.data,
          provider: {
            name: 'ai-gateway',
            model: result.model,
            latencyMs: result.latencyMs,
          },
          candidate: {
            candidateId: `${metadata.data.itemIntentId}:${metadata.data.imageId}:visual-identity`,
            level: inference.level,
            category: inference.category,
            brand: nullableValue(inference.brand),
            productName: nullableValue(inference.productName),
            model: nullableValue(inference.model),
            variant: nullableValue(inference.variant),
            confidence: inference.confidence,
            provenance: [
              { sourceId: result.requestId, sourceType: 'provider' },
            ],
          },
          signals: {
            visibleText: inference.visibleText,
            visualEvidence: inference.visualEvidence,
            alternative: nullableValue(inference.alternative ?? null),
            imageCount: images.length,
            searchQuery,
          },
        });

        publishIdentityCandidate(result.inference, result.requestId);

        await responseStream.write(
          ndjson(IdentifyStreamResultSchema.parse({ type: 'result', response })),
        );
        logger('info', 'identify.result_streamed', {
          ...metadata.data,
          providerRequestId: result.requestId,
        });

        if (response.signals.searchQuery) {
          logger('info', 'exa.request_scheduled', {
            sessionId: response.sessionId,
            itemIntentId: response.itemIntentId,
            query: response.signals.searchQuery.slice(0, 200),
          });
          void publishEvidenceSearch({
            budget: evidenceBudget,
            itemIntentId: response.itemIntentId,
            logger,
            query: response.signals.searchQuery,
            searchEvidence,
            serverEvents,
            sessionId: response.sessionId,
          });
        }
      } catch (error) {
        const failure = identifyError(error);
        logger('error', 'identity_provider.request_failed', {
          ...metadata.data,
          code: failure.error,
          message: failure.message,
        });
        await responseStream.write(
          ndjson(
            IdentifyStreamErrorSchema.parse({
              type: 'error',
              error: failure,
            }),
          ),
        );
      } finally {
        releaseBudget?.();
      }
    });
  });

  app.get(
    '/v1/control',
    upgradeWebSocket(() => ({})),
  );

  app.notFound((context) =>
    context.json({ error: 'not_found' }, 404),
  );

  app.onError((error, context) => {
    logger('error', 'request.unhandled_error', {
      method: context.req.method,
      path: context.req.path,
      message: error.message,
    });
    return context.json({ error: 'internal_error' }, 500);
  });

  return app;
}

export const app = createApiApp();
