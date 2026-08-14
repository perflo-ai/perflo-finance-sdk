import { isAuthenticatedOperation } from "./generated/auth-policy.gen.js";
import {
  type Client,
  type Config,
  createClient,
  type RequestResult,
} from "./generated/client/index.js";
import { refreshAgentToken as generatedRefreshAgentToken } from "./generated/sdk.gen.js";
import type {
  RefreshAgentTokenErrors,
  RefreshAgentTokenResponses,
} from "./generated/types.gen.js";

export const PERFLO_API_ORIGIN = "https://api-gateway.perflo.ai";

const AGENT_TOKEN_REFRESH_PATH = "/v1/agent-tokens/refresh";
const PURCHASE_QUOTE_PATH = "/v1/purchase-quotes";
const BEARER_SECURITY = [{ scheme: "bearer", type: "http" }] as const;

export type PerfloToken =
  | string
  | (() => string | undefined | Promise<string | undefined>);

export interface PerfloClientOptions {
  autoRefreshToken?: boolean;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  idempotencyKeyFactory?: () => string;
  token?: PerfloToken;
}

export type PerfloClient = Client & {
  refreshAgentToken: () => RequestResult<
    RefreshAgentTokenResponses,
    RefreshAgentTokenErrors,
    false
  >;
};

const HTTP_METHODS = [
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;

type RequestPolicyConfig = Pick<
  Config,
  "auth" | "baseUrl" | "credentials" | "fetch" | "redirect"
>;

interface RequestPolicy {
  authenticatedFetch: typeof globalThis.fetch;
  config: RequestPolicyConfig;
}

interface TokenState {
  canRefreshWith: (authorization: string) => boolean;
  resolve: () => string | undefined | Promise<string | undefined>;
  update: (token: string) => void;
}

function normalizeBaseUrl(value: string): string {
  if (value.includes("?") || value.includes("#")) {
    throw new TypeError(
      "baseUrl must be an absolute HTTP or HTTPS origin or /v1 API root",
    );
  }
  const url = new URL(value);
  const validPath =
    url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !validPath ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "baseUrl must be an absolute HTTP or HTTPS origin or /v1 API root",
    );
  }
  return url.origin;
}

function assertRequestPolicy(request: Request, origin: string): void {
  if (new URL(request.url).origin !== origin) {
    throw new TypeError("request URL must use the configured API origin");
  }
  // workerd omits this browser-only property and has no ambient credential store.
  const credentials: unknown = request.credentials;
  if (credentials !== undefined && credentials !== "omit") {
    throw new TypeError("requests must omit ambient credentials");
  }
  if (request.redirect !== "manual") {
    throw new TypeError("requests must not follow redirects");
  }
}

function createTokenState(token: PerfloToken): TokenState {
  if (typeof token === "function") {
    return {
      canRefreshWith: () => true,
      resolve: token,
      update: () => undefined,
    };
  }

  let currentToken = token;
  return {
    canRefreshWith: (authorization) =>
      authorization === `Bearer ${currentToken}`,
    resolve: () => currentToken,
    update: (refreshedToken) => {
      currentToken = refreshedToken;
    },
  };
}

async function readRefreshedToken(
  response: Response,
  authorization: string | null,
): Promise<string | undefined> {
  if (!response.ok || !authorization?.startsWith("Bearer pfa_")) {
    return;
  }

  try {
    const body: unknown = await response.clone().json();
    const expectedToken = authorization.slice("Bearer ".length);
    if (
      typeof body === "object" &&
      body !== null &&
      "access_token" in body &&
      typeof body.access_token === "string" &&
      body.access_token === expectedToken &&
      "expires_in" in body &&
      Number.isInteger(body.expires_in) &&
      (body.expires_in as number) > 0 &&
      "mandate_id" in body &&
      typeof body.mandate_id === "string" &&
      "scopes" in body &&
      Array.isArray(body.scopes) &&
      body.scopes.every((scope) => typeof scope === "string")
    ) {
      return body.access_token;
    }
  } catch {
    return;
  }
}

function withAuthorization(request: Request, token: string | undefined) {
  const headers = new Headers(request.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.delete("Authorization");
  }
  return new Request(request, { headers });
}

function createPolicyFetch({
  authenticated,
  autoRefreshToken,
  fetchImplementation,
  idempotencyKeyFactory,
  origin,
  tokenState,
}: {
  authenticated: boolean;
  autoRefreshToken: boolean;
  fetchImplementation: typeof globalThis.fetch;
  idempotencyKeyFactory?: () => string;
  origin: string;
  tokenState?: TokenState;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    assertRequestPolicy(request, origin);
    const url = new URL(request.url);
    if (
      isAuthenticatedOperation(request.method, url.pathname) !== authenticated
    ) {
      throw new TypeError(
        "request interceptors must preserve the operation authentication policy",
      );
    }
    if (!authenticated) {
      request.headers.delete("Authorization");
    }
    if (
      idempotencyKeyFactory !== undefined &&
      request.method === "POST" &&
      url.pathname === PURCHASE_QUOTE_PATH &&
      !request.headers.has("Idempotency-Key")
    ) {
      request.headers.set("Idempotency-Key", idempotencyKeyFactory());
    }

    if (url.pathname === AGENT_TOKEN_REFRESH_PATH) {
      const response = await fetchImplementation(request);
      const authorization = request.headers.get("Authorization");
      const refreshedToken =
        authorization !== null && tokenState?.canRefreshWith(authorization)
          ? await readRefreshedToken(response, authorization)
          : undefined;
      if (refreshedToken !== undefined) {
        tokenState?.update(refreshedToken);
      }
      return response;
    }

    const authorization = request.headers.get("Authorization");
    let retryRequest: Request | undefined;
    if (
      authenticated &&
      autoRefreshToken &&
      tokenState !== undefined &&
      authorization?.startsWith("Bearer pfa_") &&
      tokenState.canRefreshWith(authorization)
    ) {
      try {
        retryRequest = request.clone();
      } catch {
        retryRequest = undefined;
      }
    }

    const originalResponse = await fetchImplementation(request);
    if (
      originalResponse.status !== 401 ||
      retryRequest === undefined ||
      tokenState === undefined ||
      authorization === null
    ) {
      return originalResponse;
    }

    const refreshRequest = new Request(`${origin}${AGENT_TOKEN_REFRESH_PATH}`, {
      credentials: "omit",
      headers: {
        Accept: "application/json, application/problem+json;q=0.9",
        Authorization: authorization,
      },
      method: "POST",
      redirect: "manual",
    });

    let refreshResponse: Response;
    try {
      // Concurrent 401s may each re-stamp the pairing. The gateway operation is
      // idempotent, so cross-request locking would add state without safety.
      refreshResponse = await fetchImplementation(refreshRequest);
    } catch {
      return originalResponse;
    }

    const refreshedToken = await readRefreshedToken(
      refreshResponse,
      authorization,
    );
    if (refreshedToken === undefined) {
      return originalResponse;
    }
    tokenState.update(refreshedToken);

    let retryToken: string | undefined;
    try {
      retryToken = await tokenState.resolve();
    } catch {
      return originalResponse;
    }

    let authorizedRetry: Request;
    try {
      authorizedRetry = withAuthorization(retryRequest, retryToken);
    } catch {
      return originalResponse;
    }
    const retryResponse = await fetchImplementation(authorizedRetry);
    return retryResponse.status === 401 ? originalResponse : retryResponse;
  };
}

function hasInvalidRequestOverride(
  options: {
    baseUrl?: unknown;
    credentials?: unknown;
    redirect?: unknown;
  },
  policy: RequestPolicyConfig,
): boolean {
  let overridesOrigin = false;
  if (options.baseUrl !== undefined) {
    try {
      overridesOrigin =
        typeof options.baseUrl !== "string" ||
        new URL(options.baseUrl).origin !== policy.baseUrl;
    } catch {
      overridesOrigin = true;
    }
  }
  return (
    overridesOrigin ||
    (options.credentials !== undefined && options.credentials !== "omit") ||
    (options.redirect !== undefined && options.redirect !== "manual")
  );
}

function applyRequestPolicy<
  T extends {
    baseUrl?: unknown;
    credentials?: unknown;
    redirect?: unknown;
    security?: unknown;
    url?: unknown;
  },
>(options: T, policy: RequestPolicy, method?: string): T {
  const authenticated = isAuthenticatedOperation(
    method ?? String((options as { method?: unknown }).method),
    String(options.url),
  );
  const config = {
    ...policy.config,
    fetch: authenticated ? policy.authenticatedFetch : policy.config.fetch,
  };
  const security = authenticated ? BEARER_SECURITY : undefined;
  if (hasInvalidRequestOverride(options, config)) {
    return {
      ...options,
      auth: config.auth,
      fetch: config.fetch,
      security,
    } as T;
  }
  return { ...options, ...config, security } as T;
}

async function normalizeNoContent<T>(resultPromise: Promise<T>): Promise<T> {
  const result = await resultPromise;
  if (
    typeof result === "object" &&
    result !== null &&
    "response" in result &&
    typeof result.response === "object" &&
    result.response !== null &&
    "status" in result.response &&
    result.response.status === 204 &&
    "data" in result
  ) {
    return { ...result, data: undefined } as T;
  }
  return result;
}

function enforceClientMethods(client: Client, policy: RequestPolicy): Client {
  for (const methodName of HTTP_METHODS) {
    const method = client[methodName];
    client[methodName] = ((options) =>
      normalizeNoContent(
        method(
          applyRequestPolicy(options, policy, methodName),
        ) as Promise<unknown>,
      )) as typeof method;
  }

  const request = client.request;
  client.request = ((options) =>
    normalizeNoContent(
      request(applyRequestPolicy(options, policy)) as Promise<unknown>,
    )) as typeof request;

  for (const methodName of HTTP_METHODS) {
    const method = client.sse[methodName];
    client.sse[methodName] = ((options) =>
      method(applyRequestPolicy(options, policy, methodName))) as typeof method;
  }
  return client;
}

function enforceRequestPolicy(client: Client, origin: string): void {
  client.interceptors.request.use((request) => {
    assertRequestPolicy(request, origin);
    return request;
  });
}

export function createPerfloClient(
  options: PerfloClientOptions = {},
): PerfloClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? PERFLO_API_ORIGIN);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const tokenState =
    options.token === undefined ? undefined : createTokenState(options.token);
  const autoRefreshToken =
    tokenState !== undefined && options.autoRefreshToken !== false;
  const publicFetch = createPolicyFetch({
    authenticated: false,
    autoRefreshToken,
    fetchImplementation,
    idempotencyKeyFactory: options.idempotencyKeyFactory,
    origin: baseUrl,
    tokenState,
  });
  const authenticatedFetch = createPolicyFetch({
    authenticated: true,
    autoRefreshToken,
    fetchImplementation,
    idempotencyKeyFactory: options.idempotencyKeyFactory,
    origin: baseUrl,
    tokenState,
  });
  const config: Config = {
    baseUrl,
    credentials: "omit",
    fetch: publicFetch,
    headers: {
      Accept: "application/json, application/problem+json;q=0.9",
    },
    responseStyle: "fields",
    redirect: "manual",
    throwOnError: false,
  };

  if (tokenState !== undefined) {
    config.auth = tokenState.resolve;
  }

  const client = createClient(config) as PerfloClient;
  enforceRequestPolicy(client, baseUrl);
  enforceClientMethods(client, {
    authenticatedFetch,
    config: {
      auth: config.auth,
      baseUrl,
      credentials: "omit",
      fetch: publicFetch,
      redirect: "manual",
    },
  });
  client.refreshAgentToken = () => generatedRefreshAgentToken({ client });
  return client;
}
