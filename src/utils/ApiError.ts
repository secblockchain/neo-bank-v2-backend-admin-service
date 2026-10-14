export class ApiError extends Error {
  public statusCode: number;
  public details?: string | object;
  public clientSafe: boolean;

  constructor(
    statusCode: number,
    message: string,
    details?: string | object | Array<unknown>,
    clientSafe = false,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.clientSafe = clientSafe;
    Error.captureStackTrace(this, this.constructor);
  }
}
