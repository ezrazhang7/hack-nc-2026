import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: ContentfulStatusCode = 400) {
    super(message);
  }
}
