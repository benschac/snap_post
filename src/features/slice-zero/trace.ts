import { File, Paths } from 'expo-file-system';

export type TraceValue = boolean | number | string | null;
export type TraceAttributes = Record<string, TraceValue | undefined>;

export type TraceEvent = {
  name: string;
  offsetMs: number;
  durationMs?: number;
  attributes?: Record<string, TraceValue>;
};

type OpenSpan = {
  name: string;
  startedAtMs: number;
  attributes?: TraceAttributes;
};

export type TraceExportMetadata = {
  device: Record<string, TraceValue>;
  summary: Record<string, TraceValue>;
};

function compactAttributes(attributes?: TraceAttributes) {
  if (!attributes) return undefined;

  const entries = Object.entries(attributes).filter((entry): entry is [string, TraceValue] => {
    return entry[1] !== undefined;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export class SliceTrace {
  readonly sessionId: string;
  readonly startedAtIso: string;
  readonly slice: number;

  private readonly startedAtMs = performance.now();
  private readonly events: TraceEvent[] = [];
  private readonly openSpans = new Map<string, OpenSpan>();

  constructor(sessionId: string, slice: number) {
    this.sessionId = sessionId;
    this.slice = slice;
    this.startedAtIso = new Date().toISOString();
  }

  mark(name: string, attributes?: TraceAttributes) {
    this.events.push({
      name,
      offsetMs: performance.now() - this.startedAtMs,
      attributes: compactAttributes(attributes),
    });
  }

  beginSpan(name: string, attributes?: TraceAttributes) {
    const spanId = `${name}-${this.openSpans.size + 1}-${Date.now()}`;
    this.openSpans.set(spanId, {
      name,
      startedAtMs: performance.now(),
      attributes,
    });
    return spanId;
  }

  endSpan(spanId: string, attributes?: TraceAttributes) {
    const span = this.openSpans.get(spanId);
    if (!span) return;

    this.openSpans.delete(spanId);
    this.events.push({
      name: span.name,
      offsetMs: span.startedAtMs - this.startedAtMs,
      durationMs: performance.now() - span.startedAtMs,
      attributes: compactAttributes({ ...span.attributes, ...attributes }),
    });
  }

  export(metadata: TraceExportMetadata) {
    this.mark('trace.exported', { openSpanCount: this.openSpans.size });

    const file = new File(Paths.document, `slice-${this.slice}-${this.sessionId}.json`);
    file.create({ overwrite: true });
    file.write(
      JSON.stringify(
        {
          schemaVersion: 1,
          slice: this.slice,
          sessionId: this.sessionId,
          startedAt: this.startedAtIso,
          exportedAt: new Date().toISOString(),
          device: metadata.device,
          summary: metadata.summary,
          events: this.events,
        },
        null,
        2
      )
    );
    return file.uri;
  }
}

export function percentile(values: number[], quantile: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}
