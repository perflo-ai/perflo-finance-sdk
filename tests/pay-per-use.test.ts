import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PayPerUseError,
  PayPerUsePayment,
  PayPerUsePayVendorResponseBody,
  PayPerUseTransactionView,
  PayVendorOutcome,
} from "../src/index.js";
import {
  createPerfloClient,
  InvalidPaymentResponseError,
  isInvalidPaymentResponseError,
  isPollAbortedError,
  payVendorSafely,
} from "../src/index.js";

type FetchResponder = (
  request: Request,
  call: number,
) => Response | Promise<Response>;

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function malformedJsonResponse(): Response {
  return new Response("not json", {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function mockFetch(responder: FetchResponder) {
  const requests: Array<Request> = [];
  const implementation = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request.clone());
    return await responder(request, requests.length);
  });
  return {
    fetch: implementation as typeof globalThis.fetch,
    requests,
  };
}

function payment(
  status: PayPerUsePayment["status"],
  data: Partial<PayPerUsePayment> = {},
): PayPerUsePayVendorResponseBody {
  const terminal = ![
    "indeterminate",
    "pending_confirmation",
    "queued",
    "running",
  ].includes(status);
  return {
    data: {
      chargeIsFinal: terminal,
      status,
      terminal,
      transactionId: "transaction_id",
      ...data,
    },
    meta: { requestId: "request_id" },
  };
}

function transaction(terminal: boolean): PayPerUseTransactionView {
  return {
    amount: { amount: "-1.00", currency: "USD" },
    capability: "search",
    chargeIsFinal: terminal,
    chargedTo: terminal ? "credit" : null,
    createdAt: "2026-08-27T00:00:00Z",
    endedAt: terminal ? "2026-08-27T00:00:01Z" : null,
    failureReason: null,
    iconUrl: null,
    id: "transaction_id",
    kind: "payment",
    ledgerState: terminal ? "posted" : "pending",
    slug: "vendor",
    status: terminal ? "succeeded" : "running",
    subAccount: null,
    terminal,
  };
}

function payError(
  code: string,
  details?: Record<string, unknown>,
): PayPerUseError {
  return {
    error: { code, details, message: code },
    meta: { requestId: "request_id" },
  };
}

function duplicateInFlightPreamble(call: number): Response | undefined {
  if (call === 1) {
    return jsonResponse(payError("OPERATION_OUTCOME_UNKNOWN"), 502);
  }
  if (call === 2) {
    return jsonResponse(
      payError("DUPLICATE_PAYMENT_IN_FLIGHT", {
        transactionId: "transaction_id",
      }),
      409,
    );
  }
}

function afterDuplicateInFlight(...reads: Array<Response>): FetchResponder {
  return (_request, call) => {
    const preamble = duplicateInFlightPreamble(call);
    if (preamble !== undefined) {
      return preamble;
    }
    const read = reads[call - 3];
    if (read === undefined) {
      throw new Error(`Missing transaction-read response for call ${call}`);
    }
    return read;
  };
}

function options(fetch: typeof globalThis.fetch) {
  return {
    body: {
      input: { prompt: "hello" },
      maxCharge: { amount: "1.00", currency: "USD" },
      query: { format: "json" },
      subAccountId: "sub_account_id",
    },
    client: createPerfloClient({ fetch, token: "pfa_agent_token" }),
    slug: "vendor",
  } as const;
}

function expectSequence(
  requests: Array<Request>,
  paths: ReadonlyArray<string>,
  key?: string,
) {
  expect(
    requests.map((request) => ({
      key: request.headers.get("Idempotency-Key"),
      method: request.method,
      url: request.url,
    })),
  ).toEqual(
    paths.map((path) => ({
      key: path.startsWith("/v1/pay/") ? (key ?? expect.any(String)) : null,
      method: path.startsWith("/v1/pay/") ? "POST" : "GET",
      url: `https://api-gateway.perflo.ai${path}`,
    })),
  );
}

function expectNoTimers() {
  expect(vi.getTimerCount()).toBe(0);
}

function unknownData(outcome: PayVendorOutcome) {
  expect(outcome.data?.kind).toBe("unknown");
  if (outcome.data?.kind !== "unknown") {
    throw new Error("Expected an unknown outcome");
  }
  return outcome.data;
}

function expectAborted(outcome: PayVendorOutcome, lastValue?: string) {
  const { error } = outcome;
  if (!isPollAbortedError(error)) {
    throw new Error("Expected a PollAbortedError");
  }
  expect(error.lastValue).toBe(lastValue);
}

describe("payVendorSafely", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: 0,
      toFake: ["performance", "setTimeout", "clearTimeout"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns settled on the first attempt and preserves the whole body", async () => {
    const mocked = mockFetch(() => jsonResponse(payment("succeeded")));
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "caller_key",
    });

    expect(outcome.data).toMatchObject({
      idempotencyKey: "caller_key",
      kind: "settled",
    });
    expect(await mocked.requests[0]?.clone().json()).toEqual(
      options(mocked.fetch).body,
    );
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "caller_key");
    expectNoTimers();
  });

  it("replays a retry-safe 503 after one second with the same key", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payError("SERVICE_UNAVAILABLE", { retrySafe: true }),
            503,
          )
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(mocked.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays an unknown 502 outcome with the same key", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(payError("OPERATION_OUTCOME_UNKNOWN"), 502)
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays a malformed 200 response with the generated key", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1 ? malformedJsonResponse() : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely(options(mocked.fetch));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;
    const key = outcome.data?.idempotencyKey;

    expect(outcome.data?.kind).toBe("settled");
    expect(key).toEqual(expect.any(String));
    expectSequence(mocked.requests, ["/v1/pay/vendor", "/v1/pay/vendor"], key);
    expectNoTimers();
  });

  it("returns unknown after bounded malformed 200 responses", async () => {
    const mocked = mockFetch(() => malformedJsonResponse());
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attempts: 2,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    const data = unknownData(outcome);
    expect(data.lastError).toBeInstanceOf(SyntaxError);
    expect(data.idempotencyKey).toEqual(expect.any(String));
    expect("transactionId" in data).toBe(false);
    expect(outcome.response?.status).toBe(200);
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      data.idempotencyKey,
    );
    expectNoTimers();
  });

  it("returns an invalid-response error after bounded null 200 responses", async () => {
    const mocked = mockFetch(() => jsonResponse(null));
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attempts: 2,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    const data = unknownData(outcome);
    expect(data.lastError).toBeInstanceOf(InvalidPaymentResponseError);
    expect(isInvalidPaymentResponseError(data.lastError)).toBe(true);
    expect(data.lastError).toMatchObject({
      body: null,
      code: "INVALID_PAYMENT_RESPONSE",
      status: 200,
    });
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  // A named transaction routes this ambiguous POST response to a GET read.
  it("reads a payment envelope missing chargeIsFinal", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse({
            data: {
              status: "succeeded",
              terminal: true,
              transactionId: "transaction_id",
            },
            meta: { requestId: "request_id" },
          })
        : jsonResponse({
            data: transaction(true),
            meta: { requestId: "read_1" },
          }),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("recovered");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/transactions/transaction_id"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays an invalid payment envelope", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse({ data: "x", meta: {} })
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays an empty 204 response", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? new Response(null, { status: 204 })
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays an empty redirect response", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? new Response(null, {
            headers: { Location: "https://example.com/redirect" },
            status: 302,
          })
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("reads a known transaction after a malformed 200 replay", async () => {
    const mocked = mockFetch((_request, call) => {
      if (call === 1) {
        return jsonResponse(payment("indeterminate"));
      }
      if (call === 2) {
        return malformedJsonResponse();
      }
      return jsonResponse({
        data: transaction(true),
        meta: { requestId: "read_1" },
      });
    });
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("recovered");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor", "/v1/transactions/transaction_id"],
      "same_key",
    );
    expect(
      mocked.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(2);
    expectNoTimers();
  });

  it("keeps reading after a null 200 transaction response", async () => {
    const mocked = mockFetch((_request, call) => {
      if (call === 1) {
        return jsonResponse(
          payError("SETTLEMENT_RECORDING_FAILED", {
            transactionId: "transaction_id",
          }),
          500,
        );
      }
      return call === 2
        ? jsonResponse(null)
        : jsonResponse({
            data: transaction(true),
            meta: { requestId: "read_2" },
          });
    });
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("recovered");
    expectSequence(
      mocked.requests,
      [
        "/v1/pay/vendor",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
      ],
      "same_key",
    );
    expectNoTimers();
  });

  it("keeps reading malformed 200 transaction responses until the deadline", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payError("SETTLEMENT_RECORDING_FAILED", {
              transactionId: "transaction_id",
            }),
            500,
          )
        : malformedJsonResponse(),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
      readIntervalMs: 1_000,
      readTimeoutMs: 2_500,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    const outcome = await promise;

    const data = unknownData(outcome);
    expect(data.transactionId).toBe("transaction_id");
    expect(data.lastError).toBeInstanceOf(SyntaxError);
    expect(outcome.response?.status).toBe(200);
    expectSequence(
      mocked.requests,
      [
        "/v1/pay/vendor",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
      ],
      "same_key",
    );
    expectNoTimers();
  });

  it("returns unknown when null 200 transaction reads reach the deadline", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payError("SETTLEMENT_RECORDING_FAILED", {
              transactionId: "transaction_id",
            }),
            500,
          )
        : jsonResponse(null),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
      readIntervalMs: 1_000,
      readTimeoutMs: 2_500,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    const outcome = await promise;

    const data = unknownData(outcome);
    expect(data.transactionId).toBe("transaction_id");
    expect(data.lastError).toBeInstanceOf(InvalidPaymentResponseError);
    expect(isInvalidPaymentResponseError(data.lastError)).toBe(true);
    expect(data.lastError).toMatchObject({
      body: null,
      code: "INVALID_PAYMENT_RESPONSE",
      status: 200,
    });
    expectSequence(
      mocked.requests,
      [
        "/v1/pay/vendor",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
      ],
      "same_key",
    );
    expectNoTimers();
  });

  it("ignores a nonnumeric poll delay and uses the ordinary backoff", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payment("running", {
              poll: {
                afterMs: "soon",
                maxWaitMs: 5_000,
                url: "/poll",
              } as never,
            }),
          )
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      backoffMs: 250,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(249);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("honors Retry-After when it exceeds the backoff", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(payError("RATE_LIMITED"), 429, { "Retry-After": "5" })
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("clamps Retry-After to sixty seconds", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(payError("RATE_LIMITED"), 429, {
            "Retry-After": "3600",
          })
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("clamps poll afterMs to sixty seconds", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payment("running", {
              poll: { afterMs: 3_600_000, maxWaitMs: 3_600_000, url: "/poll" },
            }),
          )
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays a nonterminal payment after its poll delay", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payment("running", {
              poll: { afterMs: 500, maxWaitMs: 5_000, url: "/poll" },
            }),
          )
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      backoffMs: 100,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(499);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("returns settled for a terminal failed payment", async () => {
    const mocked = mockFetch(() => jsonResponse(payment("failed")));
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });

    expect(outcome.data).toMatchObject({
      data: { data: { chargeIsFinal: true, status: "failed", terminal: true } },
      idempotencyKey: "same_key",
      kind: "settled",
    });
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("does not overflow an attempt timeout above the timer limit", async () => {
    let attemptSignal: AbortSignal | undefined;
    const mocked = mockFetch(
      (request) =>
        new Promise<Response>((resolve, reject) => {
          attemptSignal = request.signal;
          const onAbort = () => {
            globalThis.clearTimeout(responseTimer);
            reject(request.signal.reason);
          };
          const responseTimer = globalThis.setTimeout(() => {
            request.signal.removeEventListener("abort", onAbort);
            resolve(jsonResponse(payment("succeeded")));
          }, 10);
          request.signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attemptTimeoutMs: 3_000_000_000,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("recovers a terminal transaction after a duplicate response", async () => {
    const finalRead = jsonResponse({
      data: transaction(true),
      meta: { requestId: "read_2" },
    });
    const mocked = mockFetch(
      afterDuplicateInFlight(
        jsonResponse({
          data: transaction(false),
          meta: { requestId: "read_1" },
        }),
        finalRead,
      ),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await promise;

    expect(outcome.data).toMatchObject({
      idempotencyKey: "same_key",
      kind: "recovered",
      transaction: { terminal: true },
    });
    expect(outcome.response).toBe(finalRead);
    expectSequence(
      mocked.requests,
      [
        "/v1/pay/vendor",
        "/v1/pay/vendor",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
      ],
      "same_key",
    );
    expectNoTimers();
  });

  it("recovers when a server error names a transaction", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payError("SETTLEMENT_RECORDING_FAILED", {
              transactionId: "transaction_id",
            }),
            500,
          )
        : jsonResponse({
            data: transaction(true),
            meta: { requestId: "read_1" },
          }),
    );
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });

    expect(outcome.data).toMatchObject({
      idempotencyKey: "same_key",
      kind: "recovered",
      transaction: { terminal: true },
    });
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/transactions/transaction_id"],
      "same_key",
    );
    expectNoTimers();
  });

  it("returns unknown when the named transaction is not found", async () => {
    const notFound = payError("TRANSACTION_NOT_FOUND", {
      transactionId: "transaction_id",
    });
    const mocked = mockFetch(
      afterDuplicateInFlight(jsonResponse(notFound, 404)),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data).toEqual({
      idempotencyKey: "same_key",
      kind: "unknown",
      lastError: notFound,
      transactionId: "transaction_id",
    });
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor", "/v1/transactions/transaction_id"],
      "same_key",
    );
    expectNoTimers();
  });

  it("keeps polling after a transient transaction-read failure", async () => {
    const mocked = mockFetch(
      afterDuplicateInFlight(
        jsonResponse(payError("SERVICE_UNAVAILABLE"), 503),
        jsonResponse({
          data: transaction(true),
          meta: { requestId: "read_2" },
        }),
      ),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("recovered");
    expectSequence(
      mocked.requests,
      [
        "/v1/pay/vendor",
        "/v1/pay/vendor",
        "/v1/transactions/transaction_id",
        "/v1/transactions/transaction_id",
      ],
      "same_key",
    );
    expectNoTimers();
  });

  it("replays an indeterminate success after its poll delay with the same key", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(
            payment("indeterminate", {
              poll: { afterMs: 5_000, maxWaitMs: 600_000, url: "/poll" },
            }),
          )
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("settled");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("keeps a successful transaction id through later ambiguous failures", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(payment("indeterminate"))
        : jsonResponse(payError("OPERATION_OUTCOME_UNKNOWN"), 502),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attempts: 4,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const outcome = await promise;

    expect(outcome.data).toMatchObject({
      idempotencyKey: "same_key",
      kind: "unknown",
      transactionId: "transaction_id",
    });
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor", "/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("returns confirmation_required for a pending 202 response", async () => {
    const mocked = mockFetch(() =>
      jsonResponse(payment("pending_confirmation"), 202),
    );
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });

    expect(outcome.data?.kind).toBe("confirmation_required");
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("returns a 422 refusal as error fields", async () => {
    const refusal = payError("MAX_CHARGE_EXCEEDED");
    const mocked = mockFetch(() => jsonResponse(refusal, 422));
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
    });

    expect(outcome.data).toBeUndefined();
    expect(outcome.error).toEqual(refusal);
    expect((outcome.error as { error: { code: string } }).error.code).toBe(
      "MAX_CHARGE_EXCEEDED",
    );
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("returns unknown after bounded transport failures", async () => {
    const rejection = new TypeError("network unavailable");
    const mocked = mockFetch(() => Promise.reject(rejection));
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attempts: 3,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await promise;

    expect(outcome.data).toMatchObject({
      idempotencyKey: "same_key",
      kind: "unknown",
      lastError: rejection,
    });
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("returns the last retry-safe 503 fields when no request was delivered", async () => {
    const unavailable = payError("SERVICE_UNAVAILABLE", { retrySafe: true });
    const mocked = mockFetch(() => jsonResponse(unavailable, 503));
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      attempts: 2,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.data).toBeUndefined();
    expect(outcome.error).toEqual(unavailable);
    expect(outcome.response?.status).toBe(503);
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor"],
      "same_key",
    );
    expectNoTimers();
  });

  it("keeps retry-safe 503 error fields when the deadline ends in backoff", async () => {
    const unavailable = payError("SERVICE_UNAVAILABLE", { retrySafe: true });
    const mocked = mockFetch(() => jsonResponse(unavailable, 503));
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      deadlineMs: 500,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(500);
    const outcome = await promise;

    expect(outcome.data).toBeUndefined();
    expect(outcome.error).toEqual(unavailable);
    expect(outcome.response?.status).toBe(503);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("honors caller abort during backoff but keeps a landed success", async () => {
    const backoffController = new AbortController();
    const backingOff = mockFetch(() => jsonResponse(payment("indeterminate")));
    const backoffPromise = payVendorSafely({
      ...options(backingOff.fetch),
      idempotencyKey: "backoff_key",
      signal: backoffController.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    backoffController.abort("stop");
    const aborted = await backoffPromise;

    expectAborted(aborted, "transaction_id");
    expect(aborted.request).toBeDefined();
    expect(aborted.request?.method).toBe(backingOff.requests[0]?.method);
    expect(aborted.request?.url).toBe(backingOff.requests[0]?.url);
    expect(aborted.request?.headers.get("Idempotency-Key")).toBe("backoff_key");
    expect(aborted.response?.status).toBe(200);
    expect(backingOff.requests).toHaveLength(1);
    expectSequence(backingOff.requests, ["/v1/pay/vendor"], "backoff_key");

    const landedController = new AbortController();
    const landed = mockFetch(() => {
      landedController.abort("after landing");
      return jsonResponse(payment("succeeded"));
    });
    const settled = await payVendorSafely({
      ...options(landed.fetch),
      idempotencyKey: "landed_key",
      signal: landedController.signal,
    });

    expect(settled.data?.kind).toBe("settled");
    expectSequence(landed.requests, ["/v1/pay/vendor"], "landed_key");
    expectNoTimers();
  });

  it("honors caller abort on a final indeterminate success", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after indeterminate");
      return jsonResponse(payment("indeterminate"));
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      attempts: 1,
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expectAborted(outcome, "transaction_id");
    expect(outcome.request).toBeDefined();
    expect(outcome.response?.status).toBe(200);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("honors caller abort on a final running success", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after running");
      return jsonResponse(payment("running"));
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      attempts: 1,
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expectAborted(outcome, "transaction_id");
    expect(outcome.request).toBeDefined();
    expect(outcome.response?.status).toBe(200);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("honors caller abort on an error response with a transaction id", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after error");
      return jsonResponse(
        payError("OPERATION_OUTCOME_UNKNOWN", {
          transactionId: "transaction_id",
        }),
        500,
      );
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      attempts: 1,
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expectAborted(outcome, "transaction_id");
    expect(outcome.request?.url.endsWith("/v1/pay/vendor")).toBe(true);
    expect(outcome.response?.status).toBe(500);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("honors caller abort on an error response without a transaction id", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after error");
      return jsonResponse(payError("OPERATION_OUTCOME_UNKNOWN"), 500);
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      attempts: 1,
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expectAborted(outcome);
    expect(outcome.response?.status).toBe(500);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("returns abort over a plain refusal", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after refusal");
      return jsonResponse(payError("MAX_CHARGE_EXCEEDED"), 422);
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      attempts: 1,
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expectAborted(outcome);
    expect(outcome.response?.status).toBe(422);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("keeps a landed confirmation requirement after abort", async () => {
    const controller = new AbortController();
    const mocked = mockFetch(() => {
      controller.abort("stop after confirmation requirement");
      return jsonResponse(payment("pending_confirmation"), 202);
    });
    const outcome = await payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
      signal: controller.signal,
    });

    expect(outcome.data?.kind).toBe("confirmation_required");
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });

  it("returns the transaction id when aborted during recovery", async () => {
    const controller = new AbortController();
    const mocked = mockFetch((request, call) => {
      const preamble = duplicateInFlightPreamble(call);
      if (preamble !== undefined) {
        return preamble;
      }
      controller.abort("stop recovery");
      return Promise.reject(request.signal.reason);
    });
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      idempotencyKey: "same_key",
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expectAborted(outcome, "transaction_id");
    expectSequence(
      mocked.requests,
      ["/v1/pay/vendor", "/v1/pay/vendor", "/v1/transactions/transaction_id"],
      "same_key",
    );
    expectNoTimers();
  });

  it("generates one RFC-4122 key and reuses it", async () => {
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(payError("OPERATION_OUTCOME_UNKNOWN"), 502)
        : jsonResponse(payment("succeeded")),
    );
    const promise = payVendorSafely(options(mocked.fetch));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;
    const key = outcome.data?.idempotencyKey;

    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expectSequence(mocked.requests, ["/v1/pay/vendor", "/v1/pay/vendor"], key);
    expectNoTimers();
  });

  it("validates maxCharge and attemptTimeoutMs before requesting", async () => {
    const mocked = mockFetch(() => jsonResponse(payment("succeeded")));

    await expect(
      payVendorSafely({
        ...options(mocked.fetch),
        body: { input: {} } as never,
      }),
    ).rejects.toThrowError(new TypeError("body.maxCharge is required"));
    await expect(
      payVendorSafely({
        ...options(mocked.fetch),
        attemptTimeoutMs: 0,
      }),
    ).rejects.toThrowError(
      new TypeError("attemptTimeoutMs must be a finite positive number"),
    );
    expect(mocked.requests).toHaveLength(0);
    expectNoTimers();
  });

  it("stops at an overall deadline before a second attempt", async () => {
    const mocked = mockFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    const promise = payVendorSafely({
      ...options(mocked.fetch),
      deadlineMs: 500,
      idempotencyKey: "same_key",
    });
    await vi.advanceTimersByTimeAsync(500);
    const outcome = await promise;

    expect(outcome.data?.kind).toBe("unknown");
    expect(mocked.requests).toHaveLength(1);
    expectSequence(mocked.requests, ["/v1/pay/vendor"], "same_key");
    expectNoTimers();
  });
});
