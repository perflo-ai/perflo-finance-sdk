type UnknownRecord = Record<PropertyKey, unknown>;

type ProblemDocument = UnknownRecord & {
  code: string;
  status: number;
  submission_uncertain: boolean;
  title: string;
  type: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isProblemDocument(value: unknown): value is ProblemDocument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    Number.isInteger(value.status) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.submission_uncertain === "boolean"
  );
}

function getProblemContext(error: unknown):
  | {
      problem: ProblemDocument;
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
  return isProblemDocument(candidate) ? candidate : undefined;
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
