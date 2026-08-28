import type { PerfloClient } from "./client.js";
import { getOperation, getPurchase } from "./generated/sdk.gen.js";
import type { OperationView, PurchaseView } from "./generated/types.gen.js";
import { isRecord } from "./guards.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type PollFields<T> =
  | {
      data: T;
      error: undefined;
      request: Request;
      response: Response;
    }
  | {
      data: undefined;
      error: unknown;
      request?: Request;
      response?: Response;
    };

export const PURCHASE_STATUS_TERMINALITY = {
  queued: false,
  running: false,
  settling: false,
  completed: true,
  input_required: true,
  no_service_available: true,
  services_failed: true,
  expired: true,
  blocked: true,
  confirmation_required: true,
  settlement_uncertain: true,
  cancelled: true,
  failed: true,
} as const satisfies Readonly<Record<PurchaseView["status"], boolean>>;

export class PollDeadlineError<T = unknown> extends Error {
  readonly code = "POLL_DEADLINE_EXCEEDED";
  declare readonly lastValue?: T;
  readonly outcomeMayStillChange = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number);
  constructor(timeoutMs: number, lastValue: T);
  constructor(timeoutMs: number, ...lastValue: [] | [T]) {
    super(`Polling deadline exceeded after ${timeoutMs} ms`);
    this.name = "PollDeadlineError";
    this.timeoutMs = timeoutMs;
    if (lastValue.length > 0) {
      this.lastValue = lastValue[0];
    }
  }
}

export class PollAbortedError<T = unknown> extends Error {
  readonly code = "POLL_ABORTED";
  declare readonly lastValue?: T;
  readonly reason: unknown;

  constructor(reason: unknown);
  constructor(reason: unknown, lastValue: T);
  constructor(reason: unknown, ...lastValue: [] | [T]) {
    super("Polling was aborted");
    this.name = "PollAbortedError";
    this.reason = reason;
    if (lastValue.length > 0) {
      this.lastValue = lastValue[0];
    }
  }
}

export function isPollDeadlineError<T = unknown>(
  value: unknown,
): value is PollDeadlineError<T> {
  return (
    isRecord(value) &&
    value.code === "POLL_DEADLINE_EXCEEDED" &&
    value.outcomeMayStillChange === true &&
    typeof value.timeoutMs === "number"
  );
}

export function isPollAbortedError<T = unknown>(
  value: unknown,
): value is PollAbortedError<T> {
  return (
    isRecord(value) &&
    value.code === "POLL_ABORTED" &&
    Object.hasOwn(value, "reason")
  );
}

export function isTerminalPurchaseStatus(
  status: PurchaseView["status"],
): boolean {
  return PURCHASE_STATUS_TERMINALITY[status];
}

export function isActionableOperation(operation: OperationView): boolean {
  const state = operation.state;
  switch (state) {
    case "requires_action":
    case "indeterminate":
    case "succeeded":
    case "failed":
    case "cancelled":
      return true;
    case "submitted":
      return operation.kind === "card_withdrawal";
    case "accepted":
    case "submitting":
      return false;
  }

  const exhaustive: never = state;
  return exhaustive;
}

export function now(): number {
  return globalThis.performance.now();
}

export function validateDelay(
  name:
    | "attemptTimeoutMs"
    | "backoffMs"
    | "deadlineMs"
    | "intervalMs"
    | "readIntervalMs"
    | "readTimeoutMs"
    | "timeoutMs",
  value: number,
) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number`);
  }
}

export function scheduleAt(deadlineAt: number, onFire: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const schedule = () => {
    if (cancelled) {
      return;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      cancelled = true;
      onFire();
      return;
    }
    timer = globalThis.setTimeout(
      schedule,
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  };

  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  };
}

export function waitForInterval(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let cancel: (() => void) | undefined;

    const finish = () => {
      cancel?.();
      signal.removeEventListener("abort", finish);
      resolve();
    };

    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    cancel = scheduleAt(now() + delayMs, finish);
  });
}

function errorFields<T>(error: unknown): PollFields<T> {
  return { data: undefined, error };
}

function setControlErrorLastValue<T>(
  error: PollAbortedError<T> | PollDeadlineError<T>,
  lastValue: T,
) {
  Object.defineProperty(error, "lastValue", {
    configurable: true,
    enumerable: true,
    value: lastValue,
    writable: true,
  });
}

export async function pollUntil<T>(options: {
  poll: (signal: AbortSignal) => Promise<PollFields<T>>;
  shouldStop: (value: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PollFields<T>> {
  const startedAt = now();
  validateDelay("intervalMs", options.intervalMs);
  validateDelay("timeoutMs", options.timeoutMs);

  let hasLastValue = false;
  let lastValue: T | undefined;

  const makeDeadlineError = () =>
    hasLastValue
      ? new PollDeadlineError(options.timeoutMs, lastValue as T)
      : new PollDeadlineError<T>(options.timeoutMs);
  const makeAbortedError = () =>
    hasLastValue
      ? new PollAbortedError(options.signal?.reason, lastValue as T)
      : new PollAbortedError<T>(options.signal?.reason);

  if (options.signal?.aborted) {
    return errorFields(makeAbortedError());
  }

  const deadlineAt = startedAt + options.timeoutMs;
  const controller = new AbortController();
  let controlError: PollAbortedError<T> | PollDeadlineError<T> | undefined;
  let resolveCurrentControl:
    | ((error: PollAbortedError<T> | PollDeadlineError<T>) => void)
    | undefined;

  const activateControl = (
    error: PollAbortedError<T> | PollDeadlineError<T>,
    abortReason: unknown,
  ) => {
    if (controlError !== undefined) {
      return;
    }
    controlError = error;
    resolveCurrentControl?.(error);
    controller.abort(abortReason);
  };
  const onCallerAbort = () =>
    activateControl(makeAbortedError(), options.signal?.reason);
  const onDeadline = () => {
    const error = makeDeadlineError();
    activateControl(error, error);
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const cancelDeadline = scheduleAt(deadlineAt, onDeadline);

  try {
    while (true) {
      if (controlError === undefined && deadlineAt - now() <= 0) {
        onDeadline();
      }
      if (controlError !== undefined) {
        return errorFields(controlError);
      }

      const currentControl = new Promise<
        PollAbortedError<T> | PollDeadlineError<T>
      >((resolve) => {
        resolveCurrentControl = resolve;
      });
      const polled = options.poll(controller.signal);

      const polledOutcome = polled.then(
        (result) => {
          if (result.error === undefined) {
            hasLastValue = true;
            lastValue = result.data;
          }
          return { kind: "result", result } as const;
        },
        (error: unknown) => ({ kind: "rejection", error }) as const,
      );
      const controlOutcome = currentControl.then(
        (error) => ({ kind: "control", error }) as const,
      );
      const outcome = await Promise.race([polledOutcome, controlOutcome]);
      resolveCurrentControl = undefined;

      if (outcome.kind === "control") {
        return errorFields(outcome.error);
      }
      if (
        outcome.kind === "result" &&
        outcome.result.error === undefined &&
        options.shouldStop(outcome.result.data as T)
      ) {
        return outcome.result;
      }
      if (controlError !== undefined) {
        if (outcome.kind === "result" && outcome.result.error === undefined) {
          setControlErrorLastValue(controlError, outcome.result.data as T);
        }
        return errorFields(controlError);
      }
      if (outcome.kind === "rejection") {
        throw outcome.error;
      }
      if (outcome.result.error !== undefined) {
        return outcome.result;
      }

      await waitForInterval(options.intervalMs, controller.signal);
    }
  } finally {
    resolveCurrentControl = undefined;
    cancelDeadline();
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export function pollPurchaseUntilTerminal(options: {
  client: PerfloClient;
  purchaseId: string;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PollFields<PurchaseView>> {
  return pollUntil({
    intervalMs: options.intervalMs,
    poll: (signal) =>
      getPurchase({
        client: options.client,
        path: { purchase_id: options.purchaseId },
        signal,
      }) as Promise<PollFields<PurchaseView>>,
    shouldStop: (purchase) => isTerminalPurchaseStatus(purchase.status),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export function pollOperationUntilActionable(options: {
  client: PerfloClient;
  operationId: string;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PollFields<OperationView>> {
  return pollUntil({
    intervalMs: options.intervalMs,
    poll: (signal) =>
      getOperation({
        client: options.client,
        path: { operation_id: options.operationId },
        signal,
      }) as Promise<PollFields<OperationView>>,
    shouldStop: isActionableOperation,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}
