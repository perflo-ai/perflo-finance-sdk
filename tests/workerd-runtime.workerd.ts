import { expect, it } from "vitest";
import {
  createPerfloClient,
  getIdentity,
  pollPurchaseUntilTerminal,
} from "../dist/index.js";

it("dispatches an authenticated request with the workerd-safe policy", async () => {
  const requests: Array<Request> = [];
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(
      JSON.stringify({
        actor_type: "customer",
        client_id: null,
        idempotency_replay_window_seconds: 86_400,
        scopes: [],
        server_time: "2026-08-14T00:00:00Z",
        subject: "customer_subject",
        wallet: "0x0000000000000000000000000000000000000000",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await getIdentity({
    client: createPerfloClient({
      fetch: fetchImplementation,
      token: "customer_access_token",
    }),
  });

  expect(result.error).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api-gateway.perflo.ai/v1/identity");
  expect(requests[0]?.headers.get("Authorization")).toBe(
    "Bearer customer_access_token",
  );
  expect(requests[0]?.credentials).toBeUndefined();
  expect(requests[0]?.headers.has("Cookie")).toBe(false);
  expect(requests[0]?.redirect).toBe("manual");
});

it("polls a terminal purchase with Web Platform APIs", async () => {
  const requests: Array<Request> = [];
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(
      JSON.stringify({
        completed_at: "2026-08-24T00:00:01Z",
        created_at: "2026-08-24T00:00:00Z",
        failure_code: null,
        failure_detail: null,
        id: "purchase_id",
        max_price: { amount: "1.00", currency: "USD" },
        next_reconcile_at: null,
        operation_id: "operation_id",
        price: { amount: "0.01", currency: "USD" },
        price_cap_enforcement: "at_charge",
        result: { answer: 42 },
        service_id: "service_id",
        status: "completed",
        submission_uncertain: false,
        target: { kind: "service", service_id: "service_id" },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await pollPurchaseUntilTerminal({
    client: createPerfloClient({
      fetch: fetchImplementation,
      token: "customer_access_token",
    }),
    intervalMs: 100,
    purchaseId: "purchase/id",
    timeoutMs: 1_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.data?.status).toBe("completed");
  expect(result.request).toBeInstanceOf(Request);
  expect(result.response).toBeInstanceOf(Response);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    "https://api-gateway.perflo.ai/v1/purchases/purchase%2Fid",
  );
  expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(requests[0]?.signal.aborted).toBe(false);
});
