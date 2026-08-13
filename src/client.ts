import {
  type Client,
  type Config,
  createClient,
} from "./generated/client/index.js";

export const PERFLO_API_ORIGIN = "https://api-gateway.perflo.ai";

export type PerfloToken =
  | string
  | (() => string | undefined | Promise<string | undefined>);

export interface PerfloClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  token?: PerfloToken;
}

export type PerfloClient = Client;

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

type RequestPolicy = Pick<
  Config,
  "auth" | "baseUrl" | "credentials" | "fetch" | "redirect"
>;

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.href !== `${url.origin}/`
  ) {
    throw new TypeError("baseUrl must be an absolute HTTP or HTTPS origin");
  }
  return url.origin;
}

function assertRequestPolicy(request: Request, origin: string): void {
  if (new URL(request.url).origin !== origin) {
    throw new TypeError("request URL must use the configured API origin");
  }
  if (request.credentials !== "omit") {
    throw new TypeError("requests must omit ambient credentials");
  }
  if (request.redirect !== "error") {
    throw new TypeError("requests must not follow redirects");
  }
}

function createPolicyFetch(
  fetchImplementation: typeof globalThis.fetch,
  origin: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    assertRequestPolicy(request, origin);
    return fetchImplementation(request);
  };
}

function hasInvalidRequestOverride(
  options: {
    baseUrl?: unknown;
    credentials?: unknown;
    redirect?: unknown;
  },
  policy: RequestPolicy,
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
    (options.redirect !== undefined && options.redirect !== "error")
  );
}

function applyRequestPolicy<
  T extends {
    baseUrl?: unknown;
    credentials?: unknown;
    redirect?: unknown;
  },
>(options: T, policy: RequestPolicy): T {
  if (hasInvalidRequestOverride(options, policy)) {
    return { ...options, auth: policy.auth, fetch: policy.fetch } as T;
  }
  return { ...options, ...policy } as T;
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
        method(applyRequestPolicy(options, policy)) as Promise<unknown>,
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
      method(applyRequestPolicy(options, policy))) as typeof method;
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
  const baseUrl = normalizeOrigin(options.baseUrl ?? PERFLO_API_ORIGIN);
  const config: Config = {
    baseUrl,
    credentials: "omit",
    fetch: createPolicyFetch(options.fetch ?? globalThis.fetch, baseUrl),
    headers: {
      Accept: "application/json, application/problem+json;q=0.9",
    },
    responseStyle: "fields",
    redirect: "error",
    throwOnError: false,
  };

  const token = options.token;
  if (token !== undefined) {
    config.auth = typeof token === "function" ? () => token() : token;
  }

  const client = createClient(config);
  enforceRequestPolicy(client, baseUrl);
  return enforceClientMethods(client, {
    auth: config.auth,
    baseUrl,
    credentials: "omit",
    fetch: config.fetch,
    redirect: "error",
  });
}
