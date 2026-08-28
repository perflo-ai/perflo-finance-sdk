import type { ProblemDetails } from "./generated/types.gen.js";
import { isRecord, type UnknownRecord } from "./guards.js";

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    typeof value.detail === "string" &&
    (value.fields === undefined ||
      value.fields === null ||
      (Array.isArray(value.fields) && value.fields.every(isRecord))) &&
    typeof value.instance === "string" &&
    typeof value.refresh_onboarding === "boolean" &&
    typeof value.request_id === "string" &&
    typeof value.retryable === "boolean" &&
    Number.isInteger(value.status) &&
    typeof value.submission_uncertain === "boolean" &&
    typeof value.title === "string" &&
    typeof value.type === "string"
  );
}

function getProblemContext(error: unknown):
  | {
      problem: ProblemDetails;
      status: number;
    }
  | undefined {
  if (!isRecord(error) || !Number.isInteger(error.status)) {
    return;
  }
  const problem = getProblem(error);
  if (problem === undefined || problem.status !== error.status) {
    return;
  }
  return { problem, status: error.status as number };
}

function getProblem(error: UnknownRecord) {
  const candidate = "problem" in error ? error.problem : error;
  return isProblemDetails(candidate) ? candidate : undefined;
}

export function isSubmissionUncertain(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.submission_uncertain === true) {
    return true;
  }
  return isRecord(error.problem) && error.problem.submission_uncertain === true;
}

/**
 * A write is definitively absent only for a non-408 4xx status, a valid
 * non-null problem document, submission_uncertain other than true, and a
 * problem code outside the idempotency_* namespace.
 */
export function isDefinitiveNoOperation(error: unknown): boolean {
  if (isSubmissionUncertain(error)) {
    return false;
  }
  const context = getProblemContext(error);
  if (
    context === undefined ||
    context.status < 400 ||
    context.status >= 500 ||
    context.status === 408
  ) {
    return false;
  }
  return !context.problem.code.startsWith("idempotency_");
}
