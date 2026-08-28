import type { PerfloClient } from "./client.js";
import {
  payPerUseGetTransaction,
  payPerUsePayVendor,
} from "./generated/sdk.gen.js";
import type {
  PayPerUseError,
  PayPerUseGetTransactionResponseBody,
  PayPerUseMoney,
  PayPerUsePayment,
  PayPerUsePayVendorRequest,
  PayPerUsePayVendorResponseBody,
  PayPerUseTransactionView,
} from "./generated/types.gen.js";
import { isRecord } from "./guards.js";
import {
  now,
  PollAbortedError,
  PollDeadlineError,
  scheduleAt,
  validateDelay,
  waitForInterval,
} from "./polling.js";

const DEFAULT_ATTEMPTS = 4;
// The relay's own payment deadline is 35 seconds; stay above it.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 40_000;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_READ_INTERVAL_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const MAX_SERVER_DELAY_MS = 60_000;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

type RequestFields = {
  request?: Request;
  response?: Response;
};

type PayAttempt =
  | ({
      data: PayPerUsePayVendorResponseBody;
      error: undefined;
    } & RequestFields)
  | ({ data: undefined; error: unknown } & RequestFields);

export class InvalidPaymentResponseError extends Error {
  readonly body: unknown;
  readonly code = "INVALID_PAYMENT_RESPONSE";
  readonly status: number | undefined;

  constructor(
    kind: "payment" | "transaction",
    body: unknown,
    status: number | undefined,
  ) {
    super(
      kind === "payment"
        ? "A successful status carried no payment"
        : "A successful status carried no transaction",
    );
    this.name = "InvalidPaymentResponseError";
    this.body = body;
    this.status = status;
  }
}

export function isInvalidPaymentResponseError(
  value: unknown,
): value is InvalidPaymentResponseError {
  return (
    isRecord(value) &&
    value.code === "INVALID_PAYMENT_RESPONSE" &&
    Object.hasOwn(value, "body")
  );
}

export type PayVendorResult =
  | {
      kind: "settled";
      data: PayPerUsePayVendorResponseBody;
      idempotencyKey: string;
    }
  | {
      kind: "confirmation_required";
      data: PayPerUsePayVendorResponseBody;
      idempotencyKey: string;
    }
  | {
      kind: "recovered";
      transaction: PayPerUseTransactionView;
      idempotencyKey: string;
    }
  | {
      kind: "unknown";
      idempotencyKey: string;
      transactionId?: string;
      lastError: unknown;
    };

/**
 * Unlike PollFields, a data result can be produced with no request made at all
 * (a deadlineMs spent up front), so the success arm's fields are optional too.
 */
export type PayVendorOutcome =
  | {
      data: PayVendorResult;
      error: undefined;
      request?: Request;
      response?: Response;
    }
  | {
      data: undefined;
      error: unknown;
      request?: Request;
      response?: Response;
    };

export interface PayVendorSafelyOptions {
  client: PerfloClient;
  slug: string;
  /**
   * Passed through whole and read on every attempt; do not mutate it during the
   * call. maxCharge is also checked at runtime.
   */
  body: Omit<PayPerUsePayVendorRequest, "maxCharge"> & {
    maxCharge: PayPerUseMoney;
  };
  /** Generated once with globalThis.crypto.randomUUID() when absent. */
  idempotencyKey?: string;
  /** Total attempts including the first. Defaults to 4. */
  attempts?: number;
  /** Per-attempt deadline. Defaults to 40 seconds, above the relay's 35-second deadline. */
  attemptTimeoutMs?: number;
  /** Base for exponential retry waits. Defaults to 1 second. */
  backoffMs?: number;
  /** Transaction-read polling interval. Defaults to 2 seconds. */
  readIntervalMs?: number;
  /** Transaction-read deadline. Defaults to 60 seconds. */
  readTimeoutMs?: number;
  /** Optional overall bound measured from invocation. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

// The `in` checks differ from `Object.hasOwn` only for an inherited key (which passes) or a
// Proxy whose `has` trap denies a real key (which rejects); a trap that claims a key cannot pass
// on its own, because the reads that follow still need a real object with a string `code`.
// This guard reads `result.error`, which is `JSON.parse` of the error body, so decoded server
// JSON produces neither; only a caller-registered error interceptor could. The guard
// deliberately does not defend against that trusted-input case.
function isPayPerUseErrorEnvelope(value: unknown): value is PayPerUseError {
  if (!isRecord(value) || !("error" in value)) {
    return false;
  }
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}

function hasEnvelopeShape(
  value: unknown,
): value is { data: Record<string, unknown>; meta: object } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    typeof value.meta === "object" &&
    value.meta !== null
  );
}

// Checks the fields this helper and its documented callers read.
function hasLifecycleFields(data: Record<string, unknown>): boolean {
  return (
    typeof data.status === "string" &&
    typeof data.terminal === "boolean" &&
    typeof data.chargeIsFinal === "boolean"
  );
}

function isPayPerUsePaymentEnvelope(
  value: unknown,
): value is PayPerUsePayVendorResponseBody {
  return (
    hasEnvelopeShape(value) &&
    typeof value.data.transactionId === "string" &&
    hasLifecycleFields(value.data)
  );
}

function isPayPerUseTransactionEnvelope(
  value: unknown,
): value is PayPerUseGetTransactionResponseBody {
  return (
    hasEnvelopeShape(value) &&
    typeof value.data.id === "string" &&
    hasLifecycleFields(value.data)
  );
}

function withFields(
  data: PayVendorResult,
  fields: RequestFields,
): PayVendorOutcome {
  return {
    data,
    error: undefined,
    request: fields.request,
    response: fields.response,
  };
}

function abortedOutcome(
  signal: AbortSignal | undefined,
  fields: RequestFields = {},
  transactionId?: string,
): PayVendorOutcome {
  return {
    data: undefined,
    error:
      transactionId === undefined
        ? new PollAbortedError(signal?.reason)
        : new PollAbortedError(signal?.reason, transactionId),
    request: fields.request,
    response: fields.response,
  };
}

function clampServerDelay(delayMs: number): number {
  return Math.min(delayMs, MAX_SERVER_DELAY_MS);
}

function pollDelayMs(view: PayPerUsePayment): number | undefined {
  const afterMs = view.poll?.afterMs;
  // Reject invalid hints so they cannot create a 1 ms retry loop.
  if (typeof afterMs !== "number" || !Number.isFinite(afterMs) || afterMs < 0) {
    return;
  }
  return clampServerDelay(afterMs);
}

function retryAfterMs(response: Response | undefined): number | undefined {
  const value = response?.headers.get("Retry-After")?.trim();
  if (!value) {
    return;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? clampServerDelay(seconds * 1_000)
    : undefined;
}

async function runWithTimeout<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  }
  const cancelTimeout = scheduleAt(now() + timeoutMs, () => controller.abort());

  try {
    return await operation(controller.signal);
  } finally {
    cancelTimeout();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function isDeadlineExhausted(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && deadlineAt - now() <= 0;
}

function effectiveTimeout(
  configured: number,
  deadlineAt: number | undefined,
): number {
  return deadlineAt === undefined
    ? configured
    : Math.min(configured, Math.max(0, deadlineAt - now()));
}

async function waitBeforeNext(
  delayMs: number,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<"ready" | "aborted" | "deadline"> {
  if (signal?.aborted) {
    return "aborted";
  }
  const waitMs = effectiveTimeout(delayMs, deadlineAt);
  if (waitMs <= 0) {
    return "deadline";
  }
  await waitForInterval(waitMs, signal ?? NEVER_ABORT_SIGNAL);
  if (signal?.aborted) {
    return "aborted";
  }
  return isDeadlineExhausted(deadlineAt) ? "deadline" : "ready";
}

async function recoverTransaction(options: {
  client: PerfloClient;
  deadlineAt: number | undefined;
  deadlineMs: number | undefined;
  idempotencyKey: string;
  payFields: RequestFields;
  readIntervalMs: number;
  readTimeoutMs: number;
  signal: AbortSignal | undefined;
  transactionId: string;
}): Promise<PayVendorOutcome> {
  const unknown = (
    lastError: unknown,
    fields: RequestFields,
  ): PayVendorOutcome =>
    withFields(
      {
        kind: "unknown",
        idempotencyKey: options.idempotencyKey,
        transactionId: options.transactionId,
        lastError,
      },
      fields,
    );
  const availableReadTime = effectiveTimeout(
    options.readTimeoutMs,
    options.deadlineAt,
  );
  if (availableReadTime <= 0) {
    return unknown(
      new PollDeadlineError(options.deadlineMs ?? options.readTimeoutMs),
      options.payFields,
    );
  }

  const readDeadlineAt = now() + availableReadTime;
  let lastError: unknown = new PollDeadlineError(availableReadTime);
  let lastFields = options.payFields;

  while (true) {
    if (options.signal?.aborted) {
      return abortedOutcome(options.signal, lastFields, options.transactionId);
    }
    const readTimeRemaining = readDeadlineAt - now();
    if (readTimeRemaining <= 0) {
      return unknown(lastError, lastFields);
    }

    const read = await runWithTimeout(
      readTimeRemaining,
      options.signal,
      (signal) =>
        payPerUseGetTransaction({
          client: options.client,
          path: { id: options.transactionId },
          signal,
        }),
    );
    lastFields = read;

    if (read.error === undefined && isPayPerUseTransactionEnvelope(read.data)) {
      const transaction = read.data.data;
      if (transaction.terminal) {
        return withFields(
          {
            kind: "recovered",
            idempotencyKey: options.idempotencyKey,
            transaction,
          },
          read,
        );
      }
      lastError = transaction;
    } else if (read.error === undefined) {
      lastError = new InvalidPaymentResponseError(
        "transaction",
        read.data,
        read.response?.status,
      );
    } else {
      lastError = read.error;
      if (options.signal?.aborted) {
        return abortedOutcome(options.signal, read, options.transactionId);
      }
      const status = read.response?.status;
      if (
        status !== undefined &&
        status !== 429 &&
        ((status >= 400 && status < 500) || status >= 600)
      ) {
        return unknown(lastError, read);
      }
    }

    const waitState = await waitBeforeNext(
      options.readIntervalMs,
      readDeadlineAt,
      options.signal,
    );
    if (waitState === "aborted") {
      return abortedOutcome(options.signal, lastFields, options.transactionId);
    }
    if (waitState === "deadline") {
      return unknown(lastError, lastFields);
    }
  }
}

/**
 * Pays a vendor with one idempotency key, bounded same-key replays, and bounded
 * transaction recovery. A successful pay response returns `settled` or
 * `confirmation_required`. `confirmation_required` means nothing has been
 * charged yet and the payment is waiting on its second check; complete it with
 * `payPerUseConfirmPayment` using `data.data.transactionId` and the instructions
 * in `data.data.confirmation`. An identified terminal transaction returns
 * `recovered`; an unresolved delivered outcome returns `unknown`. A recovered
 * result carries money state only: the transaction view has no vendor output,
 * so vendor output is not recoverable after a lost response. A recovered
 * transaction is terminal but not necessarily successful; read
 * `transaction.status` and `chargeIsFinal`.
 *
 * The helper replays the same key on an open payment (`indeterminate`, `queued`,
 * or `running`), a retry-safe 503, any other 5xx or 429 response, a transport
 * failure, or an attempt timeout. A response that carries no payment — a
 * success that is not a payment, or a redirect — is replayed under the same
 * key, or read when a transaction identifier is already known, and ends as
 * `unknown` if it never resolves; unlike an undelivered response, it does not
 * mean nothing was charged. An open payment's `poll.afterMs` is honored,
 * clamped to 60 seconds. Any error envelope carrying a transaction identifier
 * starts bounded reads until the transaction is terminal. It never creates a
 * second key during one call. `settled` means the pay call returned a terminal
 * payment view: read `data.data.status` and `chargeIsFinal`, because `failed`,
 * `expired`, `canceled`, and `reversed` are terminal too. When a successful
 * status carried no payment or no transaction, `lastError` is the client's
 * decode error or an `InvalidPaymentResponseError` whose `body` and `status`
 * are what arrived; every other `unknown` keeps the last server envelope,
 * transport error, deadline error, or non-terminal transaction view it saw.
 *
 * Refused 4xx outcomes and a run exhausted entirely by undelivered retry-safe
 * 503 responses are returned as ordinary error fields unless the call was
 * aborted first, in which case the outcome is `PollAbortedError` and the refusal
 * survives only as `response.status`; a refusal charges nothing unless its code
 * reports a payment already in flight. The helper reads the transaction such a
 * refusal names, so one that reaches you as an error field names none: reconcile
 * it by reading recent transactions before paying again or, after one the helper
 * had already identified, by reading that transaction; supply `idempotencyKey`
 * yourself when you may need to reuse a key after a refusal, because a generated
 * key is returned only on data results.
 *
 * The same key may be retried only with an identical body; a changed body or a
 * new purchase needs a new key.
 *
 * `request` and `response` on settled and confirmation results come from the
 * pay attempt, on recovered results from the final read, and on unknown results
 * from the last attempt or read when available. A caller abort returns
 * `PollAbortedError` unless a terminal result had already landed — a `settled`,
 * `confirmation_required`, or `recovered` result is returned even when the
 * signal aborted in the same turn; narrow it with `isPollAbortedError` and read
 * `lastValue` for the payment identifier when one was seen; the outcome also
 * carries the last attempt's or read's `request` and `response` when one was
 * made.
 *
 * The helper is bounded in attempts. With defaults, no server-supplied waits,
 * and no `deadlineMs`, the worst-case wall time is about 227 seconds: four
 * 40-second attempts, 1 + 2 + 4 seconds of backoff, and 60 seconds of
 * transaction reads. A `Retry-After` on a 429 or a `poll.afterMs` on an open
 * view can each add up to 60 seconds per replay; `deadlineMs` is the only
 * overall wall-clock bound. Every same-key replay has to land inside the
 * idempotency replay window that `GET /v1/identity` publishes as
 * `idempotency_replay_window_seconds`; the helper's bounded wall time is designed
 * to keep it there, and `deadlineMs` is the bound to lower when you need a
 * tighter one.
 *
 * When no key is supplied, this helper calls `globalThis.crypto.randomUUID()`
 * once; Node.js 22.18 or later and workerd provide that API.
 */
export async function payVendorSafely(
  options: PayVendorSafelyOptions,
): Promise<PayVendorOutcome> {
  const startedAt = now();
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const readIntervalMs = options.readIntervalMs ?? DEFAULT_READ_INTERVAL_MS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      "attempts must be an integer greater than or equal to 1",
    );
  }
  validateDelay("attemptTimeoutMs", attemptTimeoutMs);
  validateDelay("backoffMs", backoffMs);
  validateDelay("readIntervalMs", readIntervalMs);
  validateDelay("readTimeoutMs", readTimeoutMs);
  if (options.deadlineMs !== undefined) {
    validateDelay("deadlineMs", options.deadlineMs);
  }
  if (options.body?.maxCharge === undefined) {
    throw new TypeError("body.maxCharge is required");
  }

  const idempotencyKey =
    options.idempotencyKey ?? globalThis.crypto.randomUUID();
  const deadlineAt =
    options.deadlineMs === undefined
      ? undefined
      : startedAt + options.deadlineMs;
  let lastAttempt: PayAttempt | undefined;
  let lastError: unknown = new PollDeadlineError(
    options.deadlineMs ?? attemptTimeoutMs,
  );
  let latestTransactionId: string | undefined;
  let nextDelayMs: number | undefined;
  let sawUndelivered503Only = true;

  const unknown = (): PayVendorOutcome => {
    if (sawUndelivered503Only && lastAttempt !== undefined) {
      return {
        data: undefined,
        error: lastAttempt.error,
        request: lastAttempt.request,
        response: lastAttempt.response,
      };
    }
    return withFields(
      {
        kind: "unknown",
        idempotencyKey,
        ...(latestTransactionId === undefined
          ? {}
          : { transactionId: latestTransactionId }),
        lastError,
      },
      lastAttempt ?? {},
    );
  };

  const recover = (fields: RequestFields, transactionId: string) =>
    recoverTransaction({
      client: options.client,
      deadlineAt,
      deadlineMs: options.deadlineMs,
      idempotencyKey,
      payFields: fields,
      readIntervalMs,
      readTimeoutMs,
      signal: options.signal,
      transactionId,
    });

  const ambiguous = (
    result: PayAttempt,
  ): PayVendorOutcome | Promise<PayVendorOutcome> | undefined => {
    sawUndelivered503Only = false;
    if (options.signal?.aborted) {
      return abortedOutcome(options.signal, result, latestTransactionId);
    }
    if (latestTransactionId !== undefined) {
      return recover(result, latestTransactionId);
    }
  };

  if (options.signal?.aborted) {
    return abortedOutcome(options.signal);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt >= 2) {
      const exponentialDelay = backoffMs * 2 ** (attempt - 2);
      const waitState = await waitBeforeNext(
        Math.max(exponentialDelay, nextDelayMs ?? 0),
        deadlineAt,
        options.signal,
      );
      nextDelayMs = undefined;
      if (waitState === "aborted") {
        return abortedOutcome(
          options.signal,
          lastAttempt ?? {},
          latestTransactionId,
        );
      }
      if (waitState === "deadline") {
        return unknown();
      }
    }

    const timeoutMs = effectiveTimeout(attemptTimeoutMs, deadlineAt);
    if (timeoutMs <= 0) {
      return unknown();
    }

    const result = await runWithTimeout(timeoutMs, options.signal, (signal) =>
      payPerUsePayVendor({
        body: options.body,
        client: options.client,
        headers: { "Idempotency-Key": idempotencyKey },
        path: { slug: options.slug },
        signal,
      }),
    );
    lastAttempt = result;
    lastError = result.error === undefined ? result.data : result.error;

    if (result.error === undefined && isPayPerUsePaymentEnvelope(result.data)) {
      const view = result.data.data;
      latestTransactionId = view.transactionId;
      // Checked before the 202 branch: an indeterminate view is never a confirmation prompt.
      if (view.status === "indeterminate") {
        nextDelayMs = pollDelayMs(view);
        sawUndelivered503Only = false;
        if (options.signal?.aborted) {
          return abortedOutcome(options.signal, result, latestTransactionId);
        }
        continue;
      }
      if (
        result.response?.status === 202 ||
        view.status === "pending_confirmation"
      ) {
        return withFields(
          {
            kind: "confirmation_required",
            data: result.data,
            idempotencyKey,
          },
          result,
        );
      }
      if (!view.terminal) {
        nextDelayMs = pollDelayMs(view);
        sawUndelivered503Only = false;
        if (options.signal?.aborted) {
          return abortedOutcome(options.signal, result, latestTransactionId);
        }
        continue;
      }
      return withFields(
        { kind: "settled", data: result.data, idempotencyKey },
        result,
      );
    }

    if (result.error === undefined) {
      const transactionId = result.data?.data?.transactionId;
      if (typeof transactionId === "string") {
        latestTransactionId = transactionId;
      }
      lastError = new InvalidPaymentResponseError(
        "payment",
        result.data,
        result.response?.status,
      );
      const outcome = ambiguous(result);
      if (outcome !== undefined) {
        return outcome;
      }
      continue;
    }

    if (result.response === undefined) {
      if (options.signal?.aborted) {
        return abortedOutcome(options.signal, result, latestTransactionId);
      }
      sawUndelivered503Only = false;
      continue;
    }

    const envelope = isPayPerUseErrorEnvelope(result.error)
      ? result.error
      : undefined;
    const transactionId = envelope?.error.details?.transactionId;
    if (typeof transactionId === "string") {
      latestTransactionId = transactionId;
    }
    if (options.signal?.aborted) {
      return abortedOutcome(options.signal, result, latestTransactionId);
    }
    if (typeof transactionId === "string") {
      return recover(result, transactionId);
    }

    if (
      result.response.status === 503 &&
      envelope?.error.details?.retrySafe === true
    ) {
      // The only continue that leaves sawUndelivered503Only true: a retry-safe
      // 503 means the request was not delivered.
      continue;
    }

    if (
      result.response.status === 429 ||
      (result.response.status >= 500 && result.response.status < 600)
    ) {
      if (result.response.status === 429) {
        nextDelayMs = retryAfterMs(result.response);
      }
      sawUndelivered503Only = false;
      continue;
    }

    // A non-429 4xx refusal is returned as an error field; any other delivered
    // response (a 3xx, which this client never follows) is ambiguous and replays.
    if (result.response.status >= 400) {
      return result;
    }

    const outcome = ambiguous(result);
    if (outcome !== undefined) {
      return outcome;
    }
  }

  return unknown();
}
