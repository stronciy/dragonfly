export type ApiErrorCode =
  | "SUCCESS"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return new ApiError(500, "INTERNAL_ERROR", err.message);
  return new ApiError(500, "INTERNAL_ERROR", "Unknown error");
}
