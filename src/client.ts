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

function normalizeNoContentMethods(client: Client): Client {
  for (const methodName of HTTP_METHODS) {
    const method = client[methodName];
    client[methodName] = ((options) =>
      normalizeNoContent(method(options) as Promise<unknown>)) as typeof method;
  }
  return client;
}

function enforceRequestPolicy(client: Client, origin: string): void {
  client.interceptors.request.use((request) => {
    if (new URL(request.url).origin !== origin) {
      throw new TypeError("request URL must use the configured API origin");
    }
    if (request.credentials !== "omit") {
      throw new TypeError("requests must omit ambient credentials");
    }
    if (request.redirect !== "error") {
      throw new TypeError("requests must not follow redirects");
    }
    return request;
  });
}

export function createPerfloClient(
  options: PerfloClientOptions = {},
): PerfloClient {
  const config: Config = {
    baseUrl: normalizeOrigin(options.baseUrl ?? PERFLO_API_ORIGIN),
    credentials: "omit",
    headers: {
      Accept: "application/json, application/problem+json;q=0.9",
    },
    responseStyle: "fields",
    redirect: "error",
    throwOnError: false,
  };

  if (options.fetch) {
    config.fetch = options.fetch;
  }
  const token = options.token;
  if (token !== undefined) {
    config.auth = typeof token === "function" ? () => token() : token;
  }

  const client = createClient(config);
  enforceRequestPolicy(client, config.baseUrl ?? PERFLO_API_ORIGIN);
  return normalizeNoContentMethods(client);
}
