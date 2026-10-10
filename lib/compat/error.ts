// A client-visible error, in the shape of Meteor.Error: a numeric code (an
// HTTP-style status), a reason to show the person, and optional details.
export class ServiceError extends Error {
  error: number;
  reason: string;
  details: string | undefined;

  constructor(error: number, reason: string, details?: string) {
    super(`${reason} [${error}]`);
    this.name = "ServiceError";
    this.error = error;
    this.reason = reason;
    this.details = details;
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
