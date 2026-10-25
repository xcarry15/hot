export type AIErrorKind = 'configuration' | 'rate_limit' | 'provider' | 'network' | 'timeout' | 'content';

export class AIClientError extends Error {
  constructor(
    message: string,
    public readonly kind: AIErrorKind,
    public readonly global: boolean,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AIClientError';
  }
}
