export type ProviderBudgetErrorCode =
  | 'provider_busy'
  | 'session_request_limit';

export class ProviderBudgetError extends Error {
  readonly code: ProviderBudgetErrorCode;

  constructor(code: ProviderBudgetErrorCode, message: string) {
    super(message);
    this.name = 'ProviderBudgetError';
    this.code = code;
  }
}

export class ProviderRequestBudget {
  private activeRequests = 0;
  private readonly requestsBySession = new Map<string, number>();

  constructor(
    private readonly options: {
      maxConcurrentRequests: number;
      maxRequestsPerSession: number;
    },
  ) {}

  acquire(sessionId: string): () => void {
    const sessionRequests = this.requestsBySession.get(sessionId) ?? 0;
    if (sessionRequests >= this.options.maxRequestsPerSession) {
      throw new ProviderBudgetError(
        'session_request_limit',
        `Session provider request limit reached (${this.options.maxRequestsPerSession})`,
      );
    }

    if (this.activeRequests >= this.options.maxConcurrentRequests) {
      throw new ProviderBudgetError(
        'provider_busy',
        `Provider concurrency limit reached (${this.options.maxConcurrentRequests})`,
      );
    }

    this.requestsBySession.set(sessionId, sessionRequests + 1);
    this.activeRequests += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.activeRequests -= 1;
    };
  }
}
