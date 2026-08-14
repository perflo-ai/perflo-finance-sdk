import { expect, it } from "vitest";
import { createPerfloClient, getIdentity } from "../dist/index.js";

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
