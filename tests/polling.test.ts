import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OperationView,
  PerfloClient,
  PollFields,
  PurchaseView,
} from "../src/index.js";
import {
  isActionableOperation,
  isPollAbortedError,
  isPollDeadlineError,
  isTerminalPurchaseStatus,
  PURCHASE_STATUS_TERMINALITY,
  pollOperationUntilActionable,
  pollPurchaseUntilTerminal,
  pollUntil,
} from "../src/index.js";

type PollSuccess<T> = {
  data: T;
  error: undefined;
  request: Request;
  response: Response;
};

function pollSuccess<T>(data: T, status = 200): PollSuccess<T> {
  return {
    data,
    error: undefined,
    request: new Request("https://api-gateway.perflo.ai/v1/test"),
    response: new Response(null, { status }),
  };
}

function purchase(
  status: PurchaseView["status"],
  overrides: Partial<PurchaseView> = {},
): PurchaseView {
  return {
    completed_at: null,
    created_at: "2026-08-24T00:00:00Z",
    failure_code: null,
    failure_detail: null,
    id: "purchase_id",
    max_price: { amount: "1.00", currency: "USD" },
    next_reconcile_at: null,
    operation_id: "operation_id",
    price: null,
    price_cap_enforcement: "at_charge",
    result: null,
    service_id: null,
    status,
    submission_uncertain: false,
    target: { kind: "query", query: "test" },
    ...overrides,
  };
}

function operation(
  state: OperationView["state"],
  overrides: Partial<OperationView> = {},
): OperationView {
  return {
    action_required: null,
    approval_resolvable: false,
    authority_expires_at: null,
    created_at: "2026-08-24T00:00:00Z",
    external_reference: null,
    failure_code: null,
    failure_detail: null,
    id: "operation_id",
    kind: "transfer",
    next_reconcile_at: null,
    resource_id: null,
    resource_type: null,
    state,
    submission_uncertain: false,
    updated_at: "2026-08-24T00:00:00Z",
    ...overrides,
  };
}

function fakeClient(
  get: ReturnType<typeof vi.fn>,
  post = vi.fn(),
): { client: PerfloClient; post: ReturnType<typeof vi.fn> } {
  return {
    client: { get, post } as unknown as PerfloClient,
    post,
  };
}

function expectNoHelperWork(
  callerSignal?: AbortSignal,
  childSignals: ReadonlyArray<AbortSignal> = [],
) {
  expect(vi.getTimerCount()).toBe(0);
  if (callerSignal !== undefined) {
    expect(getEventListeners(callerSignal, "abort")).toHaveLength(0);
  }
  for (const signal of childSignals) {
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  }
}

describe("polling lifecycle predicates", () => {
  it("classifies every purchase status exhaustively", () => {
    const expected = {
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

    expect(PURCHASE_STATUS_TERMINALITY).toEqual(expected);
    for (const status of Object.keys(expected) as Array<
      PurchaseView["status"]
    >) {
      expect(isTerminalPurchaseStatus(status)).toBe(expected[status]);
    }
  });

  it.each([
    ["requires_action", true],
    ["accepted", false],
    ["submitting", false],
    ["succeeded", true],
    ["failed", true],
    ["indeterminate", true],
    ["cancelled", true],
  ] as const)("classifies the %s operation state", (state, expected) => {
    expect(isActionableOperation(operation(state))).toBe(expected);
  });

  it("stops only submitted card withdrawals", () => {
    expect(isActionableOperation(operation("submitted"))).toBe(false);
    expect(
      isActionableOperation(
        operation("submitted", { kind: "card_withdrawal" }),
      ),
    ).toBe(true);
  });

  it("treats indeterminate as actionable with reconciliation scheduled", () => {
    expect(
      isActionableOperation(
        operation("indeterminate", {
          next_reconcile_at: "2026-08-24T00:01:00Z",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes helper errors structurally across realms", () => {
    expect(
      isPollDeadlineError({
        code: "POLL_DEADLINE_EXCEEDED",
        outcomeMayStillChange: true,
        timeoutMs: 100,
      }),
    ).toBe(true);
    expect(
      isPollAbortedError({
        code: "POLL_ABORTED",
        reason: "caller stopped",
      }),
    ).toBe(true);
    expect(
      isPollDeadlineError({
        code: "POLL_DEADLINE_EXCEEDED",
        outcomeMayStillChange: false,
        timeoutMs: 100,
      }),
    ).toBe(false);
    expect(isPollAbortedError({ code: "POLL_ABORTED" })).toBe(false);
  });
});

describe("pollUntil", () => {
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

  it("returns an immediate stopping result without background work", async () => {
    const terminal = pollSuccess(purchase("completed"));
    const controller = new AbortController();
    const childSignals: Array<AbortSignal> = [];
    const poll = vi.fn(async (signal: AbortSignal) => {
      childSignals.push(signal);
      return terminal;
    });

    const result = await pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: (value) => isTerminalPurchaseStatus(value.status),
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(result).toBe(terminal);
    expect(poll).toHaveBeenCalledTimes(1);
    expectNoHelperWork(controller.signal, childSignals);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("waits after completed reads and never overlaps polls", async () => {
    const results = [
      pollSuccess(purchase("running")),
      pollSuccess(purchase("completed")),
    ];
    const starts: Array<number> = [];
    const childSignals: Array<AbortSignal> = [];
    let active = 0;
    let maximumActive = 0;
    const poll = vi.fn(async (signal: AbortSignal) => {
      const index = starts.length;
      starts.push(performance.now());
      childSignals.push(signal);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return results[index] as PollSuccess<PurchaseView>;
    });

    const pending = pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: (value) => isTerminalPurchaseStatus(value.status),
      timeoutMs: 1_000,
    });

    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 125]);
    await vi.advanceTimersByTimeAsync(25);

    expect(await pending).toBe(results[1]);
    expect(maximumActive).toBe(1);
    expectNoHelperWork(undefined, childSignals);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns an underlying poll failure unchanged", async () => {
    const error = new TypeError("network unavailable");
    const response = new Response(null, { status: 503 });
    const failure: PollFields<PurchaseView> = {
      data: undefined,
      error,
      request: new Request("https://api-gateway.perflo.ai/v1/purchases/id"),
      response,
    };
    const poll = vi.fn(async () => failure);

    const result = await pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => false,
      timeoutMs: 1_000,
    });

    expect(result).toBe(failure);
    expect(result.error).toBe(error);
    expect(result.response).toBe(response);
    expect(result.response?.status).toBe(503);
    expect(poll).toHaveBeenCalledTimes(1);
    expectNoHelperWork();
  });

  it.each([
    ["intervalMs", 0],
    ["intervalMs", -1],
    ["intervalMs", Number.NaN],
    ["intervalMs", Number.POSITIVE_INFINITY],
    ["intervalMs", Number.NEGATIVE_INFINITY],
    ["timeoutMs", 0],
    ["timeoutMs", -1],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", Number.POSITIVE_INFINITY],
    ["timeoutMs", Number.NEGATIVE_INFINITY],
  ] as const)("rejects invalid %s value %s before polling", async (name, value) => {
    const poll = vi.fn(async () => pollSuccess(purchase("completed")));
    const controller = new AbortController();

    await expect(
      pollUntil({
        intervalMs: name === "intervalMs" ? value : 1,
        poll,
        shouldStop: () => true,
        signal: controller.signal,
        timeoutMs: name === "timeoutMs" ? value : 1,
      }),
    ).rejects.toThrow(TypeError);

    expect(poll).not.toHaveBeenCalled();
    expectNoHelperWork(controller.signal);
  });

  it("accepts finite positive fractional delays", async () => {
    const terminal = pollSuccess(purchase("completed"));
    const poll = vi.fn(async () => terminal);

    await expect(
      pollUntil({
        intervalMs: 0.5,
        poll,
        shouldStop: () => true,
        timeoutMs: 0.5,
      }),
    ).resolves.toBe(terminal);
    expectNoHelperWork();
  });

  it("does not start a poll after the monotonic deadline", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2);
    const poll = vi.fn(async () => pollSuccess(purchase("completed")));

    const result = await pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => true,
      timeoutMs: 1,
    });

    expect(poll).not.toHaveBeenCalled();
    expect(isPollDeadlineError<PurchaseView>(result.error)).toBe(true);
    if (!isPollDeadlineError<PurchaseView>(result.error)) {
      throw new Error("Expected PollDeadlineError");
    }
    expect(result.error.timeoutMs).toBe(1);
    expect(result.error).not.toHaveProperty("lastValue");
    expectNoHelperWork();
  });

  it("returns caller cancellation before the first poll", async () => {
    const controller = new AbortController();
    const reason = { source: "caller" };
    controller.abort(reason);
    const poll = vi.fn(async () => pollSuccess(purchase("completed")));

    const result = await pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => true,
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(poll).not.toHaveBeenCalled();
    expect(isPollAbortedError<PurchaseView>(result.error)).toBe(true);
    if (!isPollAbortedError<PurchaseView>(result.error)) {
      throw new Error("Expected PollAbortedError");
    }
    expect(result.error.reason).toBe(reason);
    expect(result.error).not.toHaveProperty("lastValue");
    expectNoHelperWork(controller.signal);
  });

  it("aborts an in-flight poll and preserves caller ownership", async () => {
    const controller = new AbortController();
    const reason = { source: "caller" };
    const fetchAbort = new DOMException("fetch aborted", "AbortError");
    let childSignal: AbortSignal | undefined;
    const poll = vi.fn(
      (signal: AbortSignal): Promise<PollFields<PurchaseView>> => {
        childSignal = signal;
        return new Promise((resolve) => {
          const onAbort = () => resolve({ data: undefined, error: fetchAbort });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
        });
      },
    );
    const pending = pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => false,
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort(reason);
    const result = await pending;

    expect(childSignal?.aborted).toBe(true);
    expect(childSignal?.reason).toBe(reason);
    expect(result.error).not.toBe(fetchAbort);
    expect(isPollAbortedError<PurchaseView>(result.error)).toBe(true);
    if (!isPollAbortedError<PurchaseView>(result.error)) {
      throw new Error("Expected PollAbortedError");
    }
    expect(result.error.reason).toBe(reason);
    expectNoHelperWork(controller.signal, childSignal ? [childSignal] : []);
  });

  it("aborts interval sleep with the last observed value", async () => {
    const controller = new AbortController();
    const reason = "caller stopped";
    const first = purchase("running");
    let childSignal: AbortSignal | undefined;
    const poll = vi.fn(async (signal: AbortSignal) => {
      childSignal = signal;
      return pollSuccess(first);
    });
    const pending = pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => false,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(reason);
    const result = await pending;

    expect(poll).toHaveBeenCalledTimes(1);
    expect(isPollAbortedError<PurchaseView>(result.error)).toBe(true);
    if (!isPollAbortedError<PurchaseView>(result.error)) {
      throw new Error("Expected PollAbortedError");
    }
    expect(result.error.reason).toBe(reason);
    expect(result.error.lastValue).toBe(first);
    expectNoHelperWork(controller.signal, childSignal ? [childSignal] : []);
  });

  it("classifies a deadline during an in-flight poll", async () => {
    const fetchAbort = new DOMException("fetch timed out", "AbortError");
    let childSignal: AbortSignal | undefined;
    const poll = vi.fn(
      (signal: AbortSignal): Promise<PollFields<PurchaseView>> => {
        childSignal = signal;
        return new Promise((resolve) => {
          const onAbort = () => resolve({ data: undefined, error: fetchAbort });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
        });
      },
    );
    const pending = pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => false,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(childSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(childSignal?.aborted).toBe(true);
    expect(result.error).not.toBe(fetchAbort);
    expect(isPollDeadlineError<PurchaseView>(result.error)).toBe(true);
    if (!isPollDeadlineError<PurchaseView>(result.error)) {
      throw new Error("Expected PollDeadlineError");
    }
    expect(result.error.timeoutMs).toBe(50);
    expect(result.error.outcomeMayStillChange).toBe(true);
    expect(result.error).not.toHaveProperty("lastValue");
    expect(childSignal?.reason).toBe(result.error);
    expectNoHelperWork(undefined, childSignal ? [childSignal] : []);
  });

  it("returns the last value when the deadline interrupts sleep", async () => {
    const first = purchase("settling");
    let childSignal: AbortSignal | undefined;
    const poll = vi.fn(async (signal: AbortSignal) => {
      childSignal = signal;
      return pollSuccess(first);
    });
    const pending = pollUntil({
      intervalMs: 100,
      poll,
      shouldStop: () => false,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(poll).toHaveBeenCalledTimes(1);
    expect(isPollDeadlineError<PurchaseView>(result.error)).toBe(true);
    if (!isPollDeadlineError<PurchaseView>(result.error)) {
      throw new Error("Expected PollDeadlineError");
    }
    expect(result.error.lastValue).toBe(first);
    expect(first.submission_uncertain).toBe(false);
    expectNoHelperWork(undefined, childSignal ? [childSignal] : []);
  });
});

describe("polling resource wrappers", () => {
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

  it("polls queued, running, and settling purchases until terminal", async () => {
    const results = [
      pollSuccess(purchase("queued")),
      pollSuccess(purchase("running")),
      pollSuccess(purchase("settling")),
      pollSuccess(purchase("completed")),
    ];
    const get = vi
      .fn()
      .mockResolvedValueOnce(results[0])
      .mockResolvedValueOnce(results[1])
      .mockResolvedValueOnce(results[2])
      .mockResolvedValueOnce(results[3]);
    const { client } = fakeClient(get);
    const pending = pollPurchaseUntilTerminal({
      client,
      intervalMs: 100,
      purchaseId: "purchase/id",
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;

    expect(result).toBe(results[3]);
    expect(get).toHaveBeenCalledTimes(4);
    for (const [options] of get.mock.calls) {
      expect(options).toMatchObject({
        path: { purchase_id: "purchase/id" },
        responseStyle: "fields",
        url: "/v1/purchases/{purchase_id}",
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expectNoHelperWork();
  });

  it("returns purchase read failures by object identity", async () => {
    const failure: PollFields<PurchaseView> = {
      data: undefined,
      error: { code: "rate_limited" },
      request: new Request("https://api-gateway.perflo.ai/v1/purchases/id"),
      response: new Response(null, { status: 429 }),
    };
    const get = vi.fn().mockResolvedValue(failure);
    const { client } = fakeClient(get);

    const result = await pollPurchaseUntilTerminal({
      client,
      intervalMs: 100,
      purchaseId: "purchase_id",
      timeoutMs: 1_000,
    });

    expect(result).toBe(failure);
    expect(result.response?.status).toBe(429);
    expect(get).toHaveBeenCalledTimes(1);
    expectNoHelperWork();
  });

  it("stops an operation after accepted and submitting without mutations", async () => {
    const results = [
      pollSuccess(operation("accepted")),
      pollSuccess(operation("submitting")),
      pollSuccess(operation("requires_action")),
    ];
    const get = vi
      .fn()
      .mockResolvedValueOnce(results[0])
      .mockResolvedValueOnce(results[1])
      .mockResolvedValueOnce(results[2]);
    const { client, post } = fakeClient(get);
    const pending = pollOperationUntilActionable({
      client,
      intervalMs: 100,
      operationId: "operation/id",
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(result).toBe(results[2]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(post).not.toHaveBeenCalled();
    for (const [options] of get.mock.calls) {
      expect(options).toMatchObject({
        path: { operation_id: "operation/id" },
        responseStyle: "fields",
        url: "/v1/operations/{operation_id}",
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expectNoHelperWork();
  });

  it("continues ordinary submitted operations and stops card withdrawals", async () => {
    const results = [
      pollSuccess(operation("submitted")),
      pollSuccess(operation("submitted", { kind: "card_withdrawal" })),
    ];
    const get = vi
      .fn()
      .mockResolvedValueOnce(results[0])
      .mockResolvedValueOnce(results[1]);
    const { client } = fakeClient(get);
    const pending = pollOperationUntilActionable({
      client,
      intervalMs: 100,
      operationId: "operation_id",
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(results[1]);
    expect(get).toHaveBeenCalledTimes(2);
    expectNoHelperWork();
  });
});
