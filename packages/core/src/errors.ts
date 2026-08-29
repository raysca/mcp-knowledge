export type ErrorBody = {
  error: { code: string; message: string; requestId: string };
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function errorBody(
  error: { code: string; message: string },
  requestId: string,
): ErrorBody {
  return { error: { code: error.code, message: error.message, requestId } };
}
