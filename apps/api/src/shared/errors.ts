import type { ErrorCode } from "../../../../packages/contracts/src/index.ts";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | null;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
