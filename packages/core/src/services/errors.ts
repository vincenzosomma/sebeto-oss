/** Application errors mapped to HTTP status codes by the API error handler. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (what: string, id: string) => new AppError(404, 'not_found', `${what} ${id} not found`);
export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const unavailable = (message: string) => new AppError(503, 'unavailable', message);
