import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ProblemDetails } from "../src/index.js";
import {
  createPerfloClient,
  createPurchase,
  createPurchaseQuote,
  createTransfer,
  deleteSubscription,
  displayCurrency,
  getIdentity,
  getPurchase,
  isDefinitiveNoOperation,
  isProblemDetails,
  isSubmissionUncertain,
  PERFLO_API_ORIGIN,
  pollDevice,
  publicConfig,
  redeemConnectCode,
  refreshAgentToken,
  refreshToken,
  serviceCapabilities,
  startDevice,
} from "../src/index.js";

type FetchResponder = (
  request: Request,
  call: number,
) => Response | Promise<Response>;

function mockFetch(responder: FetchResponder = () => jsonResponse({})) {
  const requests: Array<Request> = [];
  const implementation = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request.clone());
    return await responder(request, requests.length);
  });

  return {
    fetch: implementation as typeof globalThis.fetch,
    implementation,
    requests,
  };
}

function problemDetails(
  overrides: Partial<ProblemDetails> = {},
): ProblemDetails {
  return {
    code: "authentication_required",
    detail: "The request failed.",
    fields: null,
    instance: "/v1/identity",
    refresh_onboarding: false,
    request_id: "request_id",
    retryable: false,
    status: 401,
    submission_uncertain: false,
    title: "Request failed",
    type: "https://api-gateway.perflo.ai/problems/request_failed",
    ...overrides,
  };
}

function agentRefreshResponse(accessToken: string) {
  return {
    access_token: accessToken,
    expires_in: 86_400,
    mandate_id: "mandate_id",
    scopes: ["purchases:execute"],
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
  it.each([
    ["responseStyle", { responseStyle: "data" as const }],
    ["throwOnError", { throwOnError: true as const }],
  ])("rejects shared %s changes atomically", (_name, invalid) => {
    const client = createPerfloClient();
    const before = client.getConfig();

    expect(() =>
      client.setConfig({
        ...invalid,
        headers: { "X-Rejected-Mutation": "yes" },
      } as never),
    ).toThrow(TypeError);

    const after = client.getConfig();
    expect(after).toMatchObject({
      responseStyle: "fields",
      throwOnError: false,
    });
    expect(after.fetch).toBe(before.fetch);
    expect(
      new Headers(after.headers as HeadersInit).has("X-Rejected-Mutation"),
    ).toBe(false);
  });

  it("keeps fields and non-throwing defaults when shared options are undefined", () => {
    const client = createPerfloClient();

    const configured = client.setConfig({
      headers: { "X-Allowed-Mutation": "yes" },
      responseStyle: undefined,
      throwOnError: undefined,
    });

    expect(configured).toMatchObject({
      responseStyle: "fields",
      throwOnError: false,
    });
    expect(
      new Headers(configured.headers as HeadersInit).get("X-Allowed-Mutation"),
    ).toBe("yes");
  });

  it("keeps generated results field-style and direct data results available", async () => {
    const mocked = mockFetch(() => jsonResponse({ actor_type: "agent" }));
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_agent_pairing_token",
    });

    const generated = await getIdentity({
      client,
      responseStyle: "data",
    } as never);
    const direct = await client.get<
      { 200: { actor_type: string } },
      never,
      false,
      "data"
    >({ responseStyle: "data", url: "/v1/identity" });

    expect(generated).toMatchObject({
      data: { actor_type: "agent" },
      response: expect.any(Response),
    });
    expect(direct).toEqual({ actor_type: "agent" });
  });

  it("supports per-call throwing without changing generated defaults", async () => {
    const error = problemDetails({ code: "validation_error", status: 422 });
    const mocked = mockFetch(() => jsonResponse(error, 422));
    const client = createPerfloClient({ fetch: mocked.fetch });

    await expect(getIdentity({ client, throwOnError: true })).rejects.toEqual(
      error,
    );

    const returned = await getIdentity({ client });
    expect(returned.data).toBeUndefined();
    expect(returned.error).toEqual(error);
    expect(returned.response?.status).toBe(422);
    expect(client.getConfig()).toMatchObject({
      responseStyle: "fields",
      throwOnError: false,
    });
  });

  it("keeps per-call data mode on direct transport requests", async () => {
    const identity = { actor_type: "agent" };
    const error = problemDetails({ status: 422 });
    const mocked = mockFetch((_request, call) =>
      call === 1 ? jsonResponse(identity) : jsonResponse(error, 422),
    );
    const client = createPerfloClient({ fetch: mocked.fetch });

    const success = await client.get<
      { 200: typeof identity },
      { 422: ProblemDetails },
      false,
      "data"
    >({ responseStyle: "data", url: "/v1/identity" });
    const failure = await client.get<
      { 200: typeof identity },
      { 422: ProblemDetails },
      false,
      "data"
    >({ responseStyle: "data", url: "/v1/identity" });

    expect(success).toEqual(identity);
    expect(failure).toBeUndefined();
    expect(client.getConfig().responseStyle).toBe("fields");
  });

  it("uses the production origin and canonicalizes origin or /v1 base URLs", async () => {
    const production = mockFetch();
    const local = mockFetch();
    const custom = mockFetch();

    await publicConfig({
      client: createPerfloClient({ fetch: production.fetch }),
    });
    await getIdentity({
      client: createPerfloClient({
        baseUrl: "https://api-gateway.perflo.ai/v1",
        fetch: custom.fetch,
        token: "pfa_agent_pairing_token",
      }),
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
    expect(custom.requests[0]?.url).toBe(
      "https://api-gateway.perflo.ai/v1/identity",
    );
  });

  it.each([
    "relative/path",
    "ftp://api-gateway.perflo.ai",
    "https://user:password@api-gateway.perflo.ai",
    "https://api-gateway.perflo.ai/v2",
    "https://api-gateway.perflo.ai/v1/identity",
    "https://api-gateway.perflo.ai/v1?",
    "https://api-gateway.perflo.ai/v1#",
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

  it("blocks origin rewrites from later request interceptors", async () => {
    const mocked = mockFetch();
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "customer_access_token",
    });
    client.interceptors.request.use(
      (request) => new Request("https://example.invalid/v1/identity", request),
    );

    const result = await getIdentity({ client });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(mocked.implementation).not.toHaveBeenCalled();
  });

  it("blocks credential rewrites from later request interceptors", async () => {
    const mocked = mockFetch();
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "customer_access_token",
    });
    client.interceptors.request.use(
      (request) => new Request(request, { credentials: "include" }),
    );

    const result = await getIdentity({ client });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(mocked.implementation).not.toHaveBeenCalled();
  });

  it.each([
    ["protected to public", getIdentity, "/v1/public-config"],
    ["public to protected", publicConfig, "/v1/identity"],
  ])("blocks %s rewrites from later request interceptors", async (_description, operation, rewrittenPath) => {
    const mocked = mockFetch();
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_agent_token",
    });
    client.interceptors.request.use(
      (request) => new Request(`${PERFLO_API_ORIGIN}${rewrittenPath}`, request),
    );

    const result = await operation({ client });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(mocked.implementation).not.toHaveBeenCalled();
  });

  it.each([
    "client configuration",
    "operation options",
  ])("blocks origin rewrites after replacing fetch through %s", async (overrideLocation) => {
    const configured = mockFetch();
    const replacement = mockFetch();
    const client = createPerfloClient({
      fetch: configured.fetch,
      token: "customer_access_token",
    });
    client.interceptors.request.use(
      (request) => new Request("https://example.invalid/v1/identity", request),
    );
    if (overrideLocation === "client configuration") {
      client.setConfig({ fetch: replacement.fetch });
    }

    const result = await getIdentity({
      client,
      ...(overrideLocation === "operation options"
        ? { fetch: replacement.fetch }
        : {}),
    });

    expect(result.error).toBeInstanceOf(TypeError);
    expect(configured.implementation).not.toHaveBeenCalled();
    expect(replacement.implementation).not.toHaveBeenCalled();
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
    expect(mocked.requests[0]?.redirect).toBe("manual");
    expect(mocked.requests[0]?.headers.get("Accept")).toBe(
      "application/json, application/problem+json;q=0.9",
    );
  });

  it.each([
    { credentials: "include" as const },
    { redirect: "error" as const },
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

describe("agent token refresh", () => {
  it("keeps the explicit refresh helper non-throwing and field-style", async () => {
    const refreshed = agentRefreshResponse("pfa_original_token");
    const mocked = mockFetch((_request, call) =>
      call === 1
        ? jsonResponse(refreshed)
        : jsonResponse(problemDetails(), 401),
    );
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_original_token",
    });

    const success = await client.refreshAgentToken();
    const failure = await client.refreshAgentToken();

    expect(success.data).toEqual(refreshed);
    expect(success.request).toBeInstanceOf(Request);
    expect(success.response?.status).toBe(200);
    expect(failure.data).toBeUndefined();
    expect(failure.error).toMatchObject({ code: "authentication_required" });
    expect(failure.response?.status).toBe(401);
    expect(client.getConfig()).toMatchObject({
      responseStyle: "fields",
      throwOnError: false,
    });
  });

  it("refreshes a 401 and retries the exact purchase request once", async () => {
    const purchaseBodies: Array<Array<number>> = [];
    let purchaseAttempt = 0;
    const mocked = mockFetch(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/agent-tokens/refresh") {
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      purchaseAttempt += 1;
      purchaseBodies.push(
        Array.from(new Uint8Array(await request.arrayBuffer())),
      );
      return purchaseAttempt === 1
        ? jsonResponse(problemDetails(), 401)
        : jsonResponse({ id: "operation_id" }, 202);
    });
    const body = {
      max_price: { amount: "12.34", currency: "USD" },
      target: { kind: "query" as const, query: "find a flight" },
    };

    const result = await createPurchase({
      body,
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
      headers: {
        "Idempotency-Key": "purchase_idempotency_key",
        "Idempotency-Replay-Not-After": "2026-08-13T12:34:56Z",
      },
    });

    expect(result.data).toEqual({ id: "operation_id" });
    expect(
      mocked.requests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/v1/purchases", "/v1/agent-tokens/refresh", "/v1/purchases"]);
    expect(mocked.requests[0]?.method).toBe(mocked.requests[2]?.method);
    expect(mocked.requests[0]?.url).toBe(mocked.requests[2]?.url);
    expect(purchaseBodies[0]).toEqual(purchaseBodies[1]);
    expect(mocked.requests[0]?.headers.get("Idempotency-Key")).toBe(
      mocked.requests[2]?.headers.get("Idempotency-Key"),
    );
    expect(
      mocked.requests[0]?.headers.get("Idempotency-Replay-Not-After"),
    ).toBe(mocked.requests[2]?.headers.get("Idempotency-Replay-Not-After"));
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([
      "Bearer pfa_expired_token",
      "Bearer pfa_expired_token",
      "Bearer pfa_expired_token",
    ]);
    expect(
      mocked.requests.map((request) => [request.credentials, request.redirect]),
    ).toEqual([
      ["omit", "manual"],
      ["omit", "manual"],
      ["omit", "manual"],
    ]);
  });

  it("propagates an operation abort into automatic refresh", async () => {
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let refreshSignal: AbortSignal | undefined;
    const mocked = mockFetch((request) => {
      if (new URL(request.url).pathname !== "/v1/agent-tokens/refresh") {
        return jsonResponse(problemDetails(), 401);
      }
      refreshSignal = request.signal;
      refreshStarted();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(request.signal.reason);
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          onAbort();
        }
      });
    });
    const controller = new AbortController();
    const reason = new DOMException("poll stopped", "AbortError");
    const pending = getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
      signal: controller.signal,
    });
    await started;

    controller.abort(reason);
    const result = await pending;

    expect(refreshSignal?.aborted).toBe(true);
    expect(refreshSignal?.reason).toBe(reason);
    expect(result.error).toMatchObject({ code: "authentication_required" });
    expect(result.response?.status).toBe(401);
  });

  it("returns the original 401 when the retry also returns 401", async () => {
    const originalResponse = jsonResponse(
      problemDetails({ code: "original_unauthorized" }),
      401,
      { "X-Attempt": "original" },
    );
    const mocked = mockFetch((_request, call) => {
      if (call === 1) {
        return originalResponse;
      }
      if (call === 2) {
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      return jsonResponse(problemDetails({ code: "retry_unauthorized" }), 401, {
        "X-Attempt": "retry",
      });
    });

    const result = await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
    });

    expect(result.error).toMatchObject({ code: "original_unauthorized" });
    expect(result.response).toBe(originalResponse);
    expect(result.response?.headers.get("X-Attempt")).toBe("original");
    expect(mocked.implementation).toHaveBeenCalledTimes(3);
    expect(
      mocked.requests.filter(
        (request) =>
          new URL(request.url).pathname === "/v1/agent-tokens/refresh",
      ),
    ).toHaveLength(1);
  });

  it("returns a lost retry response as transport uncertainty", async () => {
    const originalResponse = jsonResponse(problemDetails(), 401);
    const retryError = new TypeError("retry response lost");
    let retryBodyDispatched = false;
    const mocked = mockFetch(async (request, call) => {
      if (call === 1) {
        return originalResponse;
      }
      if (call === 2) {
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      retryBodyDispatched = (await request.arrayBuffer()).byteLength > 0;
      throw retryError;
    });

    const result = await createPurchase({
      body: {
        max_price: { amount: "12.34", currency: "USD" },
        target: { kind: "query", query: "find a flight" },
      },
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
      headers: { "Idempotency-Key": "purchase_idempotency_key" },
    });

    expect(retryBodyDispatched).toBe(true);
    expect(result.error).toBe(retryError);
    expect(result.response).toBeUndefined();
    expect(result.response).not.toBe(originalResponse);
    expect(isDefinitiveNoOperation(result.error)).toBe(false);
    expect(mocked.implementation).toHaveBeenCalledTimes(3);
  });

  it("never recurses when the refresh operation returns 401", async () => {
    const mocked = mockFetch(() => jsonResponse(problemDetails(), 401));
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_expired_token",
    });

    const result = await client.refreshAgentToken();

    expect(result.error).toMatchObject({ code: "authentication_required" });
    expect(result.response?.status).toBe(401);
    expect(mocked.implementation).toHaveBeenCalledTimes(1);
    expect(new URL(mocked.requests[0]?.url ?? "").pathname).toBe(
      "/v1/agent-tokens/refresh",
    );
  });

  it("does not refresh a public operation that returns 401", async () => {
    const mocked = mockFetch(() => jsonResponse(problemDetails(), 401));

    const result = await publicConfig({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
      security: [{ scheme: "bearer", type: "http" }],
    });

    expect(result.response?.status).toBe(401);
    expect(mocked.implementation).toHaveBeenCalledTimes(1);
    expect(mocked.requests[0]?.headers.has("Authorization")).toBe(false);
  });

  it("strips authorization added to a public request by an interceptor", async () => {
    const mocked = mockFetch();
    let interceptedAuthorization: string | null | undefined;
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_agent_token",
    });
    client.interceptors.request.use((request) => {
      request.headers.set("Authorization", "Bearer pfa_injected_token");
      return request;
    });
    client.interceptors.response.use((response, request) => {
      interceptedAuthorization = request.headers.get("Authorization");
      return response;
    });

    const result = await publicConfig({ client });

    expect(mocked.requests[0]?.headers.has("Authorization")).toBe(false);
    expect(interceptedAuthorization).toBeNull();
    expect(result.request?.headers.has("Authorization")).toBe(false);
  });

  it("does not let operation options downgrade protected authentication", async () => {
    const mocked = mockFetch(() => jsonResponse({ actor_type: "agent" }));

    const result = await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_agent_token",
      }),
      security: [],
    });

    expect(result.data).toEqual({ actor_type: "agent" });
    expect(mocked.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer pfa_agent_token",
    );
  });

  it("does not refresh or pin a static token replaced by an interceptor", async () => {
    const originalResponse = jsonResponse(problemDetails(), 401);
    const mocked = mockFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/agent-tokens/refresh") {
        return jsonResponse(agentRefreshResponse("pfa_substituted_token"));
      }
      return request.headers.get("Authorization") ===
        "Bearer pfa_substituted_token"
        ? originalResponse
        : jsonResponse({ actor_type: "agent" });
    });
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_configured_token",
    });
    const interceptor = client.interceptors.request.use((request) => {
      request.headers.set("Authorization", "Bearer pfa_substituted_token");
      return request;
    });

    const first = await getIdentity({ client });
    client.interceptors.request.eject(interceptor);
    const second = await getIdentity({ client });

    expect(first.response).toBe(originalResponse);
    expect(second.data).toEqual({ actor_type: "agent" });
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer pfa_substituted_token", "Bearer pfa_configured_token"]);
    expect(
      mocked.requests.some(
        (request) =>
          new URL(request.url).pathname === "/v1/agent-tokens/refresh",
      ),
    ).toBe(false);
  });

  it("leaves customer-token refresh to the generated public operation", async () => {
    let customerAccessToken = "customer_expired_access_token";
    const resolveToken = vi.fn(() => customerAccessToken);
    const mocked = mockFetch((request, call) => {
      const path = new URL(request.url).pathname;
      if (path === "/cli/token/refresh") {
        return jsonResponse({
          data: {
            accessJwt: "customer_refreshed_access_token",
            expiresAt: 1_800_000_000_000,
            refreshToken: "customer_rotated_refresh_token",
          },
          success: true,
        });
      }
      return call === 1
        ? jsonResponse(problemDetails(), 401)
        : jsonResponse({ actor_type: "customer" });
    });
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: resolveToken,
    });

    const expired = await getIdentity({ client });
    const refreshed = await refreshToken({
      body: { refreshToken: "customer_refresh_token" },
      client,
    });
    customerAccessToken =
      refreshed.data?.data?.accessJwt ?? customerAccessToken;
    const identity = await getIdentity({ client });

    expect(expired.response?.status).toBe(401);
    expect(identity.data).toEqual({ actor_type: "customer" });
    expect(
      mocked.requests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/v1/identity", "/cli/token/refresh", "/v1/identity"]);
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([
      "Bearer customer_expired_access_token",
      null,
      "Bearer customer_refreshed_access_token",
    ]);
    expect(resolveToken).toHaveBeenCalledTimes(2);
  });

  it("re-resolves callback tokens after refresh without pinning the response", async () => {
    let storedToken = "pfa_expired_token";
    const resolveToken = vi.fn(() => storedToken);
    const mocked = mockFetch((request, call) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/agent-tokens/refresh") {
        storedToken = "pfa_credential_store_token";
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      return call === 1
        ? jsonResponse(problemDetails(), 401)
        : jsonResponse({ actor_type: "agent" });
    });

    const result = await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: resolveToken,
      }),
    });

    expect(result.data).toEqual({ actor_type: "agent" });
    expect(resolveToken).toHaveBeenCalledTimes(2);
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([
      "Bearer pfa_expired_token",
      "Bearer pfa_expired_token",
      "Bearer pfa_credential_store_token",
    ]);
  });

  it("allows concurrent expired-token requests to refresh independently", async () => {
    let protectedAttempts = 0;
    let refreshes = 0;
    const mocked = mockFetch((request) => {
      if (new URL(request.url).pathname === "/v1/agent-tokens/refresh") {
        refreshes += 1;
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      protectedAttempts += 1;
      return protectedAttempts <= 2
        ? jsonResponse(problemDetails(), 401)
        : jsonResponse({ actor_type: "agent" });
    });
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_expired_token",
    });

    const results = await Promise.all([
      getIdentity({ client }),
      getIdentity({ client }),
    ]);

    expect(results.map((result) => result.data)).toEqual([
      { actor_type: "agent" },
      { actor_type: "agent" },
    ]);
    expect(refreshes).toBe(2);
    expect(protectedAttempts).toBe(4);
  });

  it.each([
    ["missing access_token", {}],
    ["non-string access_token", { access_token: 123 }],
    ["empty access_token", { access_token: "" }],
    ["partial response", { access_token: "pfa_original_token" }],
    ["wrong token class", agentRefreshResponse("customer_access_token")],
    ["changed token", agentRefreshResponse("pfa_changed_token")],
    ["whitespace-padded token", agentRefreshResponse(" pfa_original_token ")],
  ])("keeps token state after a malformed refresh response: %s", async (_name, refreshBody) => {
    const originalResponse = jsonResponse(problemDetails(), 401);
    const mocked = mockFetch((_request, call) => {
      if (call === 1) {
        return originalResponse;
      }
      return call === 2
        ? jsonResponse(refreshBody)
        : jsonResponse({ actor_type: "agent" });
    });
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_original_token",
    });

    const failed = await getIdentity({ client });
    const nextRequest = await getIdentity({ client });

    expect(failed.response).toBe(originalResponse);
    expect(nextRequest.data).toEqual({ actor_type: "agent" });
    expect(mocked.implementation).toHaveBeenCalledTimes(3);
    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual([
      "Bearer pfa_original_token",
      "Bearer pfa_original_token",
      "Bearer pfa_original_token",
    ]);
  });

  it("can disable automatic refresh", async () => {
    const mocked = mockFetch(() => jsonResponse(problemDetails(), 401));

    const result = await getIdentity({
      client: createPerfloClient({
        autoRefreshToken: false,
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
    });

    expect(result.response?.status).toBe(401);
    expect(mocked.implementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    "network failure",
    "non-2xx response",
  ])("returns the original 401 after refresh %s", async (failure) => {
    const originalResponse = jsonResponse(problemDetails(), 401);
    const mocked = mockFetch((_request, call) => {
      if (call === 1) {
        return originalResponse;
      }
      if (failure === "network failure") {
        throw new TypeError("refresh connection lost");
      }
      return jsonResponse(problemDetails({ status: 503 }), 503);
    });

    const result = await getIdentity({
      client: createPerfloClient({
        fetch: mocked.fetch,
        token: "pfa_expired_token",
      }),
    });

    expect(result.response).toBe(originalResponse);
    expect(mocked.implementation).toHaveBeenCalledTimes(2);
  });

  it("keeps static state after an invalid generated refresh response", async () => {
    const mocked = mockFetch((request) =>
      new URL(request.url).pathname === "/v1/agent-tokens/refresh"
        ? jsonResponse(agentRefreshResponse("pfa_changed_token"))
        : jsonResponse({ actor_type: "agent" }),
    );
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_original_token",
    });

    await refreshAgentToken({ client });
    await getIdentity({ client });

    expect(mocked.requests[1]?.headers.get("Authorization")).toBe(
      "Bearer pfa_original_token",
    );
  });

  it("does not pin a static token substituted during explicit refresh", async () => {
    const mocked = mockFetch((request) =>
      new URL(request.url).pathname === "/v1/agent-tokens/refresh"
        ? jsonResponse(agentRefreshResponse("pfa_substituted_token"))
        : jsonResponse({ actor_type: "agent" }),
    );
    const client = createPerfloClient({
      fetch: mocked.fetch,
      token: "pfa_configured_token",
    });
    const interceptor = client.interceptors.request.use((request) => {
      request.headers.set("Authorization", "Bearer pfa_substituted_token");
      return request;
    });

    await client.refreshAgentToken();
    client.interceptors.request.eject(interceptor);
    await getIdentity({ client });

    expect(
      mocked.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer pfa_substituted_token", "Bearer pfa_configured_token"]);
  });
});

describe("purchase quote idempotency", () => {
  it("attaches factory keys only to quotes and preserves caller keys", async () => {
    const idempotencyKeyFactory = vi.fn(() => "factory_quote_key");
    const mocked = mockFetch();
    const interceptedKeys: Array<string | null> = [];
    const client = createPerfloClient({
      fetch: mocked.fetch,
      idempotencyKeyFactory,
      token: "pfa_agent_token",
    });
    client.interceptors.response.use((response, request) => {
      interceptedKeys.push(request.headers.get("Idempotency-Key"));
      return response;
    });
    const quoteBody = {
      target: { kind: "service" as const, service_id: "service_id" },
    };

    const generatedQuote = await createPurchaseQuote({
      body: quoteBody,
      client,
    });
    await createPurchaseQuote({
      body: quoteBody,
      client,
      headers: { "idempotency-key": "caller_quote_key" },
    });
    await createPurchase({
      body: {
        max_price: { amount: "12.34", currency: "USD" },
        target: { kind: "query", query: "find a flight" },
      },
      client,
      headers: {} as never,
    });

    expect(idempotencyKeyFactory).toHaveBeenCalledTimes(1);
    expect(mocked.requests[0]?.headers.get("Idempotency-Key")).toBe(
      "factory_quote_key",
    );
    expect(mocked.requests[1]?.headers.get("Idempotency-Key")).toBe(
      "caller_quote_key",
    );
    expect(mocked.requests[2]?.headers.has("Idempotency-Key")).toBe(false);
    expect(generatedQuote.request?.headers.get("Idempotency-Key")).toBe(
      "factory_quote_key",
    );
    expect(interceptedKeys).toEqual([
      "factory_quote_key",
      "caller_quote_key",
      null,
    ]);
  });

  it("reuses one factory key when a quote refreshes and retries", async () => {
    const idempotencyKeyFactory = vi.fn(() => "factory_quote_key");
    let quoteAttempt = 0;
    const mocked = mockFetch((request) => {
      if (new URL(request.url).pathname === "/v1/agent-tokens/refresh") {
        return jsonResponse(agentRefreshResponse("pfa_expired_token"));
      }
      quoteAttempt += 1;
      return quoteAttempt === 1
        ? jsonResponse(problemDetails(), 401)
        : jsonResponse({ id: "quote_id" }, 201);
    });

    const result = await createPurchaseQuote({
      body: {
        target: { kind: "service", service_id: "service_id" },
      },
      client: createPerfloClient({
        fetch: mocked.fetch,
        idempotencyKeyFactory,
        token: "pfa_expired_token",
      }),
    });

    expect(result.data).toEqual({ id: "quote_id" });
    expect(idempotencyKeyFactory).toHaveBeenCalledTimes(1);
    expect(mocked.requests[0]?.headers.get("Idempotency-Key")).toBe(
      mocked.requests[2]?.headers.get("Idempotency-Key"),
    );
  });

  it("does not attach a factory key after an interceptor rewrites a quote", async () => {
    const idempotencyKeyFactory = vi.fn(() => "factory_quote_key");
    const mocked = mockFetch();
    const client = createPerfloClient({
      fetch: mocked.fetch,
      idempotencyKeyFactory,
      token: "pfa_agent_token",
    });
    client.interceptors.request.use(
      (request) => new Request(`${PERFLO_API_ORIGIN}/v1/purchases`, request),
    );

    await createPurchaseQuote({
      body: {
        target: { kind: "service", service_id: "service_id" },
      },
      client,
    });

    expect(idempotencyKeyFactory).not.toHaveBeenCalled();
    expect(mocked.requests[0]?.headers.has("Idempotency-Key")).toBe(false);
  });
});

describe("submission uncertainty helpers", () => {
  it("narrows complete problem details", () => {
    const problem: unknown = problemDetails({ code: "validation_error" });

    expect(isProblemDetails(problem)).toBe(true);
    if (!isProblemDetails(problem)) {
      throw new Error("Expected problem details");
    }
    expect(problem.code).toBe("validation_error");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing required field", { ...problemDetails(), detail: undefined }],
    ["a non-integer status", problemDetails({ status: 401.5 })],
    ["a non-object field error", problemDetails({ fields: [null] as never })],
  ])("rejects %s as problem details", (_name, value) => {
    expect(isProblemDetails(value)).toBe(false);
  });

  it.each([
    [
      "422 validation problem",
      problemDetails({
        code: "validation_error",
        status: 422,
        type: "about:blank",
      }),
      true,
    ],
    [
      "409 idempotency conflict",
      problemDetails({ code: "idempotency_key_conflict", status: 409 }),
      false,
    ],
    [
      "504 uncertain submission",
      problemDetails({
        code: "purchase_settlement_uncertain",
        status: 504,
        submission_uncertain: true,
      }),
      false,
    ],
    ["400 without a problem document", { status: 400 }, false],
    ["408 problem", problemDetails({ status: 408 }), false],
    [
      "problem without a code",
      { ...problemDetails({ status: 422 }), code: undefined },
      false,
    ],
    [
      "problem without submission uncertainty",
      {
        ...problemDetails({ status: 422 }),
        submission_uncertain: undefined,
      },
      false,
    ],
  ])("classifies %s", (_name, error, expected) => {
    expect(isDefinitiveNoOperation(error)).toBe(expected);
  });

  it("accepts the platform's wrapped problem shape", () => {
    expect(
      isDefinitiveNoOperation({
        problem: problemDetails({
          code: "validation_error",
          status: 422,
        }),
        status: 422,
      }),
    ).toBe(true);
  });

  it("rejects a wrapped problem whose statuses disagree", () => {
    expect(
      isDefinitiveNoOperation({
        problem: problemDetails({
          code: "purchase_settlement_uncertain",
          status: 504,
          submission_uncertain: true,
        }),
        status: 422,
      }),
    ).toBe(false);
  });

  it("resolves conflicting uncertainty extensions toward uncertainty", () => {
    const error = {
      problem: problemDetails({
        code: "validation_error",
        status: 422,
        submission_uncertain: false,
      }),
      status: 422,
      submission_uncertain: true,
    };

    expect(isSubmissionUncertain(error)).toBe(true);
    expect(isDefinitiveNoOperation(error)).toBe(false);
  });

  it("recognizes only explicit submission uncertainty", () => {
    expect(
      isSubmissionUncertain(problemDetails({ submission_uncertain: true })),
    ).toBe(true);
    expect(
      isSubmissionUncertain({
        problem: problemDetails({ submission_uncertain: true }),
      }),
    ).toBe(true);
    expect(
      isSubmissionUncertain(problemDetails({ submission_uncertain: false })),
    ).toBe(false);
    expect(isSubmissionUncertain(null)).toBe(false);
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

      expect(transfer.error).toEqual({});
      expect(transfer.response?.status).toBe(307);
      expect(refresh.error).toEqual({});
      expect(refresh.response?.status).toBe(307);
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

  it.each([
    [
      "HTML",
      () =>
        new Response("<!doctype html><title>Unexpected success</title>", {
          headers: { "Content-Type": "text/html" },
          status: 200,
        }),
    ],
    [
      "an empty body",
      () =>
        new Response("", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    ],
    [
      "an explicit zero-length body",
      () =>
        new Response(null, {
          headers: {
            "Content-Length": "0",
            "Content-Type": "application/json",
          },
          status: 200,
        }),
    ],
  ])("returns a decode error for $0 on a JSON operation", async (_name, response) => {
    const mocked = mockFetch(response);

    const result = await getIdentity({
      client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
    });

    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(result.response?.status).toBe(200);
  });

  it.each([
    [
      "HTML",
      () =>
        new Response("<!doctype html><title>Unexpected success</title>", {
          headers: { "Content-Type": "text/html" },
          status: 200,
        }),
    ],
    [
      "an empty body",
      () =>
        new Response("", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    ],
  ])("throws the raw decode error for $0 in throw mode", async (_name, response) => {
    const mocked = mockFetch(response);
    let caught: unknown;

    try {
      await getIdentity({
        client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
        throwOnError: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyntaxError);
    expect(caught).not.toHaveProperty("response");
  });

  it.each([
    [
      "HTML",
      () =>
        new Response("<!doctype html><title>Unexpected success</title>", {
          headers: { "Content-Type": "text/html" },
          status: 202,
        }),
    ],
    [
      "an empty body",
      () =>
        new Response("", {
          headers: { "Content-Type": "application/json" },
          status: 202,
        }),
    ],
  ])("does not accept $0 as a successful financial mutation", async (_name, response) => {
    const mocked = mockFetch(response);

    const result = await createTransfer({
      body: { quote_id: "transfer_quote" },
      client: createPerfloClient({ fetch: mocked.fetch, token: "token" }),
      headers: {
        "Confirmation-Intent-ID": "confirmation_intent",
        "Idempotency-Key": "idempotency_key",
      },
    });

    expect(mocked.implementation).toHaveBeenCalledTimes(1);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(result.response?.status).toBe(202);
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
      type: "https://api-gateway.perflo.ai/problems/provider_timeout",
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
      type: "https://api-gateway.perflo.ai/problems/rate_limited",
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
