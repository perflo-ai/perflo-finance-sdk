import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createPerfloClient,
  createPurchase,
  createTransfer,
  deleteSubscription,
  displayCurrency,
  getIdentity,
  getPurchase,
  pollDevice,
  publicConfig,
  redeemConnectCode,
  refreshToken,
  serviceCapabilities,
  startDevice,
} from "../src/index.js";

type FetchResponder = (request: Request, call: number) => Response;

function mockFetch(responder: FetchResponder = () => jsonResponse({})) {
  const requests: Array<Request> = [];
  const implementation = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    return responder(request, requests.length);
  });

  return {
    fetch: implementation as typeof globalThis.fetch,
    implementation,
    requests,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    status,
  });
}

describe("createPerfloClient", () => {
  it("uses the production origin by default and accepts a local origin", async () => {
    const production = mockFetch();
    const local = mockFetch();

    await publicConfig({
      client: createPerfloClient({ fetch: production.fetch }),
    });
    await publicConfig({
      client: createPerfloClient({
        baseUrl: "http://127.0.0.1:8000/",
        fetch: local.fetch,
      }),
    });

    expect(production.requests[0]?.url).toBe(
      "https://api-gateway.perflo.ai/v1/public-config",
    );
    expect(local.requests[0]?.url).toBe(
      "http://127.0.0.1:8000/v1/public-config",
    );
  });

  it.each([
    "relative/path",
    "ftp://api-gateway.perflo.ai",
    "https://user:password@api-gateway.perflo.ai",
    "https://api-gateway.perflo.ai/v1",
    "https://api-gateway.perflo.ai?region=test",
    "https://api-gateway.perflo.ai#fragment",
  ])("rejects invalid origins before fetching: %s", (baseUrl) => {
    const mocked = mockFetch();

    expect(() => createPerfloClient({ baseUrl, fetch: mocked.fetch })).toThrow(
      TypeError,
    );
    expect(mocked.implementation).not.toHaveBeenCalled();
  });

  it("keeps customer and agent bearer tokens isolated", async () => {
    const customer = mockFetch();
    const agent = mockFetch();

    await getIdentity({
      client: createPerfloClient({
        fetch: customer.fetch,
        token: "customer_access_token",
      }),
    });
    await getIdentity({
      client: createPerfloClient({
        fetch: agent.fetch,
        token: "pfa_agent_pairing_token",
      }),
    });

    expect(customer.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer customer_access_token",
    );
    expect(agent.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer pfa_agent_pairing_token",
    );
  });

  it.each([
    "customer_access_token",
    "pfa_agent_pairing_token",
  ])("blocks operation-level origin overrides for %s", async (token) => {
    const mocked = mockFetch();
    const result = await getIdentity({
      baseUrl: "http://example.invalid",
      client: createPerfloClient({ fetch: mocked.fetch, token }),
    });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(mocked.implementation).not.toHaveBeenCalled();
  });

  it("resolves token callbacks for each secured request", async () => {
    const mocked = mockFetch();
    let token = "first_token";
    const resolveToken = vi.fn(async () => token);
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: resolveToken,
    });

    await getIdentity({ client });
    token = "rotated_token";
    await getIdentity({ client });

    expect(resolveToken).toHaveBeenCalledTimes(2);
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer first_token", "Bearer rotated_token"]);
  });

  it("omits credentials and sends the SDK Accept header", async () => {
    const mocked = mockFetch();

    await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "customer_access_token",
      }),
    });

    expect(mocked.requests[0]?.credentials).toBe("omit");
    expect(mocked.requests[0]?.redirect).toBe("error");
    expect(mocked.requests[0]?.headers.get("Accept")).toBe(
      "application/json, application/problem+json;q=0.9",
    );
  });

  it.each([
    { credentials: "include" as const },
    { redirect: "follow" as const },
  ])("blocks per-operation request policy overrides", async (override) => {
    const mocked = mockFetch();
    const result = await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "customer_access_token",
      }),
      ...override,
    });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(mocked.implementation).not.toHaveBeenCalled();
  });
});

describe("generated operations", () => {
  it("never authenticates any of the five public operations", async () => {
    const mocked = mockFetch();
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "configured_but_unused_token",
    });

    await pollDevice({ body: { sid: "device_session" }, client });
    await startDevice({
      body: { clientName: "backend", deviceName: "server" },
      client,
    });
    await refreshToken({ body: { refreshToken: "refresh_token" }, client });
    await redeemConnectCode({
      body: { agent_name: "agent", code: "connect_code" },
      client,
    });
    await publicConfig({ client });

    expect(mocked.requests).toHaveLength(5);
    for (const request of mocked.requests) {
      expect(request.headers.has("Authorization")).toBe(false);
    }
  });

  it("serializes financial control headers without changing their values", async () => {
    const mocked = mockFetch();
    const client = createPerfloClient({ fetch: mocked.fetch, token: "token" });

    await createTransfer({
      body: { quote_id: "transfer_quote" },
      client,
      headers: {
        "Confirmation-Intent-ID": "confirmation_intent",
        "Idempotency-Key": "transfer_idempotency_key",
      },
    });
    await createPurchase({
      body: {
        max_price: { amount: "12.34", currency: "USD" },
        target: { kind: "query", query: "find a flight" },
      },
      client,
      headers: {
        "Confirmation-Intent-ID": "purchase_confirmation",
        "Idempotency-Key": "purchase_idempotency_key",
        "Idempotency-Replay-Not-After": "2026-08-13T12:34:56Z",
      },
    });

    expect(mocked.requests[0]?.headers.get("Confirmation-Intent-ID")).toBe(
      "confirmation_intent",
    );
    expect(mocked.requests[0]?.headers.get("Idempotency-Key")).toBe(
      "transfer_idempotency_key",
    );
    expect(mocked.requests[1]?.headers.get("Confirmation-Intent-ID")).toBe(
      "purchase_confirmation",
    );
    expect(mocked.requests[1]?.headers.get("Idempotency-Key")).toBe(
      "purchase_idempotency_key",
    );
    expect(
      mocked.requests[1]?.headers.get("Idempotency-Replay-Not-After"),
    ).toBe("2026-08-13T12:34:56Z");
  });

  it("encodes generated path and query values", async () => {
    const mocked = mockFetch();
    const client = createPerfloClient({ fetch: mocked.fetch, token: "token" });

    await getPurchase({
      client,
      path: { purchase_id: "purchase/with spaces" },
    });
    await serviceCapabilities({
      client,
      query: {
        mandate_id: "mandate/id",
        query: "flight & hotel",
      },
    });

    expect(mocked.requests[0]?.url).toBe(
      "https://api-gateway.perflo.ai/v1/purchases/purchase%2Fwith%20spaces",
    );
    const queryUrl = new URL(mocked.requests[1]?.url ?? "");
    expect(queryUrl.pathname).toBe("/v1/service-capabilities");
    expect(queryUrl.searchParams.get("mandate_id")).toBe("mandate/id");
    expect(queryUrl.searchParams.get("query")).toBe("flight & hotel");
  });

  it("makes one attempt when the transfer fetch rejects", async () => {
    const networkError = new TypeError("connection lost");
    const mocked = mockFetch(() => {
      throw networkError;
    });

    const result = await createTransfer({
      body: { quote_id: "transfer_quote" },
      client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
      headers: {
        "Confirmation-Intent-ID": "confirmation_intent",
        "Idempotency-Key": "idempotency_key",
      },
    });

    expect(mocked.implementation).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(networkError);
    expect(result.response).toBeUndefined();
  });

  it("does not follow redirects for writes or public credential exchange", async () => {
    let redirectedRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/redirect-target") {
        redirectedRequests += 1;
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(307, { Location: "/redirect-target" });
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not expose a TCP address");
      }
      const client = createPerfloClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "customer_access_token",
      });
      const transfer = await createTransfer({
        body: { quote_id: "transfer_quote" },
        client,
        headers: {
          "Confirmation-Intent-ID": "confirmation_intent",
          "Idempotency-Key": "idempotency_key",
        },
      });
      const refresh = await refreshToken({
        body: { refreshToken: "refresh_token" },
        client,
      });

      expect(transfer.error).toBeInstanceOf(TypeError);
      expect(refresh.error).toBeInstanceOf(TypeError);
      expect(redirectedRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("normalizes a 204 response to undefined data", async () => {
    const mocked = mockFetch(() => new Response(null, { status: 204 }));

    const result = await deleteSubscription({
      client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
      path: { subscription_id: "subscription_id" },
    });

    expect(result.data).toBeUndefined();
    expect(result.response?.status).toBe(204);
  });

  it("preserves a JSON null success body", async () => {
    const mocked = mockFetch(() => jsonResponse(null));

    const result = await displayCurrency({
      client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
    });

    expect(result.data).toBeNull();
  });

  it("returns ProblemDetails fields and exposes replay headers", async () => {
    const problem = {
      code: "provider_timeout",
      detail: "The provider response is uncertain.",
      fields: null,
      instance: "/v1/transfers",
      refresh_onboarding: false,
      request_id: "request_id",
      retryable: false,
      status: 504,
      submission_uncertain: true,
      title: "Provider timeout",
      type: "https://apidocs.perflo.ai/problems/provider-timeout",
    };
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(problem, 504)
        : jsonResponse({}, 202, { "Idempotent-Replayed": "true" }),
    );
    const client = createPerfloClient({ fetch: mocked.fetch, token: "token" });
    const options = {
      body: { quote_id: "transfer_quote" },
      client,
      headers: {
        "Confirmation-Intent-ID": "confirmation_intent",
        "Idempotency-Key": "idempotency_key",
      },
    } as const;

    const failed = await createTransfer(options);
    const replayed = await createTransfer(options);

    expect(failed.error).toMatchObject({
      code: "provider_timeout",
      retryable: false,
      submission_uncertain: true,
    });
    expect(replayed.response?.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("preserves gateway and provider CLI error bodies", async () => {
    const problem = {
      code: "rate_limited",
      detail: "Wait before sending another request.",
      fields: null,
      instance: "/cli/device/poll",
      refresh_onboarding: false,
      request_id: "request_id",
      retryable: true,
      status: 429,
      submission_uncertain: false,
      title: "Rate limit exceeded",
      type: "https://apidocs.perflo.ai/problems/rate-limited",
    };
    const provider = {
      error: { code: "too_many_requests", message: "Slow down" },
      success: false,
    };
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(problem, 429, {
            "Content-Type": "application/problem+json",
          })
        : jsonResponse(provider, 429),
    );
    const client = createPerfloClient({ fetch: mocked.fetch });

    const gatewayResult = await pollDevice({
      body: { sid: "gateway_limit" },
      client,
    });
    const providerResult = await pollDevice({
      body: { sid: "provider_limit" },
      client,
    });

    expect(gatewayResult.error).toMatchObject({
      code: "rate_limited",
      request_id: "request_id",
      retryable: true,
    });
    expect(providerResult.error).toEqual(provider);
  });
});
