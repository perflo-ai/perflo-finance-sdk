import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  type FileHandle,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  PayPerUseAgentKeyMetadata,
  PayPerUseMoney,
  PayPerUseSubAccountListItem,
  PayPerUseTransactionView,
  PerfloClient,
} from "../src/index.js";
import { createOpenApiResponseValidator } from "./lib/openapi-response-validator.ts";

type SdkModule = typeof import("../src/index.js");
type HttpMethod =
  | "delete"
  | "get"
  | "head"
  | "options"
  | "patch"
  | "post"
  | "put"
  | "trace";
type JsonRecord = Record<string, unknown>;
type OperationBehavior =
  | "blocked"
  | "behavior-failure"
  | "contract-failure"
  | "expected-refusal"
  | "request-failure"
  | "success";

interface OpenApiOperation {
  operationId?: string;
  responses: Record<string, OpenApiResponse>;
  tags?: Array<string>;
}

interface OpenApiResponse {
  content?: Record<string, unknown>;
}

interface OpenApiDocument {
  info?: { version?: string };
  openapi?: string;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

interface SdkFieldResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}

export interface ExpectedOutcome {
  behavior: "expected-refusal" | "success";
  code: string | null;
  status: number;
}

interface OperationRecord {
  behavior: OperationBehavior;
  contractErrors: Array<string>;
  detail: string;
  errorCode: string | null;
  operation: OperationName;
  status: number | null;
}

interface InvocationResult {
  record: OperationRecord;
  result?: SdkFieldResult;
}

interface RunOptions {
  help: boolean;
  mutations: boolean;
  preflight: boolean;
  reconcile: boolean;
  spend: boolean;
  unlock: boolean;
}

interface Runtime {
  entrySha256: string;
  openapi: OpenApiDocument;
  openapiPath: string;
  openapiSha256: string;
  openapiSource: string;
  packageName: string;
  packageVersion: string;
  sdk: SdkModule;
  sdkTreeSha256: string;
}

interface RunContext {
  accountClient: PerfloClient;
  addSecret: (value: string | undefined) => void;
  apiOrigin: string;
  charged: PayPerUseMoney | "unknown" | null;
  invoked: Set<OperationName>;
  journalStatus: LiveJournal["status"] | null;
  maxCharge: PayPerUseMoney;
  records: Array<OperationRecord>;
  redact: (value: string) => string;
  sdk: SdkModule;
  validateResponse: ResponseValidator;
  vendorSlug: string;
}

export interface PreflightState {
  accountId?: string;
  agentKeys: Array<PayPerUseAgentKeyMetadata>;
  failures: Array<string>;
  subAccounts: Array<PayPerUseSubAccountListItem>;
  vendor?: JsonRecord;
}

interface JournalContext {
  accountId: string;
  apiOrigin: string;
  entrySha256: string;
  openapiSha256: string;
  sdkVersion: string;
  sdkTreeSha256: string;
}

interface JournalResource {
  id?: string;
  phase: "absent" | "active" | "dispatching" | "retired" | "uncertain";
}

interface JournalPayment {
  body: JsonRecord;
  charged: PayPerUseMoney | "unknown" | null;
  dispatchedAt?: string;
  idempotencyKey: string;
  phase:
    | "absent"
    | "confirmation_required"
    | "dispatching"
    | "failed"
    | "succeeded"
    | "uncertain";
  slug: string;
  transactionId?: string;
}

export interface LiveJournal {
  agentKey: JournalResource;
  baseline: {
    agentKeyIds: Array<string>;
    subAccountIds: Array<string>;
  };
  context: JournalContext;
  keyName: string;
  label: string;
  payment: JournalPayment;
  runId: string;
  startedAt: string;
  status: "active" | "complete" | "unresolved";
  subAccount: JournalResource;
  updatedLabel: string;
  version: 1;
}

type ResponseValidator = (
  operation: OperationName,
  result: SdkFieldResult,
) => Promise<Array<string>>;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API_ORIGIN = "https://api-gateway.perflo.ai";
const DEFAULT_JOURNAL_PATH = resolve(
  REPOSITORY_ROOT,
  ".perflo-pay-per-use-live.json",
);
const DEFAULT_PAYMENT_MAX_CHARGE = {
  amount: "0.01",
  currency: "USD",
} as const satisfies PayPerUseMoney;
const DEFAULT_VENDOR_SLUG = "parallel-search-mpp";
const REQUEST_TIMEOUT_MS = 30_000;
const HTTP_OPERATION_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const satisfies ReadonlyArray<HttpMethod>;

export const OPERATION_ROUTES = {
  payPerUseGetAccount: ["get", "/v1/account", "pay_per_use_get_account"],
  payPerUseRevokeAccountKey: [
    "delete",
    "/v1/account-key",
    "pay_per_use_revoke_account_key",
  ],
  payPerUseGetAccountKey: [
    "get",
    "/v1/account-key",
    "pay_per_use_get_account_key",
  ],
  payPerUseCreateAccountKey: [
    "post",
    "/v1/account-key",
    "pay_per_use_create_account_key",
  ],
  payPerUseListCapabilities: [
    "get",
    "/v1/capabilities",
    "pay_per_use_list_capabilities",
  ],
  payPerUseGetCapability: [
    "get",
    "/v1/capabilities/{slug}",
    "pay_per_use_get_capability",
  ],
  payPerUseGetCallerAgentKey: [
    "get",
    "/v1/key",
    "pay_per_use_get_caller_agent_key",
  ],
  payPerUseListAgentKeys: ["get", "/v1/keys", "pay_per_use_list_agent_keys"],
  payPerUseCreateAgentKey: ["post", "/v1/keys", "pay_per_use_create_agent_key"],
  payPerUseRevokeAgentKey: [
    "delete",
    "/v1/keys/{id}",
    "pay_per_use_revoke_agent_key",
  ],
  payPerUsePayVendor: ["post", "/v1/pay/{slug}", "pay_per_use_pay_vendor"],
  payPerUseConfirmPayment: [
    "post",
    "/v1/payments/{id}/confirm",
    "pay_per_use_confirm_payment",
  ],
  payPerUseListResources: [
    "get",
    "/v1/resources",
    "pay_per_use_list_resources",
  ],
  payPerUseGetResource: [
    "get",
    "/v1/resources/{id}",
    "pay_per_use_get_resource",
  ],
  payPerUseSearchVendors: ["get", "/v1/search", "pay_per_use_search_vendors"],
  payPerUseSearchVendorsWithBody: [
    "post",
    "/v1/search",
    "pay_per_use_search_vendors_with_body",
  ],
  payPerUseRejectBulkSubAccountDeletion: [
    "delete",
    "/v1/sub-accounts",
    "pay_per_use_reject_bulk_sub_account_deletion",
  ],
  payPerUseListSubAccounts: [
    "get",
    "/v1/sub-accounts",
    "pay_per_use_list_sub_accounts",
  ],
  payPerUseCreateSubAccount: [
    "post",
    "/v1/sub-accounts",
    "pay_per_use_create_sub_account",
  ],
  payPerUseDisableSubAccount: [
    "delete",
    "/v1/sub-accounts/{id}",
    "pay_per_use_disable_sub_account",
  ],
  payPerUseGetSubAccount: [
    "get",
    "/v1/sub-accounts/{id}",
    "pay_per_use_get_sub_account",
  ],
  payPerUseUpdateSubAccount: [
    "patch",
    "/v1/sub-accounts/{id}",
    "pay_per_use_update_sub_account",
  ],
  payPerUseListTransactions: [
    "get",
    "/v1/transactions",
    "pay_per_use_list_transactions",
  ],
  payPerUseGetTransaction: [
    "get",
    "/v1/transactions/{id}",
    "pay_per_use_get_transaction",
  ],
  payPerUseGetVendor: ["get", "/v1/vendors/{slug}", "pay_per_use_get_vendor"],
} as const satisfies Record<
  string,
  readonly [HttpMethod, string, `pay_per_use_${string}`]
>;

type OperationName = keyof typeof OPERATION_ROUTES;

const READ_ONLY_OPERATIONS = new Set<OperationName>([
  "payPerUseGetAccount",
  "payPerUseGetAccountKey",
  "payPerUseListCapabilities",
  "payPerUseGetCapability",
  "payPerUseGetVendor",
  "payPerUseListAgentKeys",
  "payPerUseListResources",
  "payPerUseGetResource",
  "payPerUseSearchVendors",
  "payPerUseSearchVendorsWithBody",
  "payPerUseListSubAccounts",
  "payPerUseListTransactions",
  "payPerUseGetTransaction",
]);

export function parseArguments(arguments_: Array<string>): RunOptions {
  const known = new Set([
    "--help",
    "--mutations",
    "--preflight",
    "--reconcile",
    "--spend",
    "--unlock",
  ]);
  const unknown = arguments_.filter(
    (argument) => argument !== "--" && !known.has(argument),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown option: ${unknown.join(", ")}`);
  }
  const flags = new Set(arguments_.filter((argument) => argument !== "--"));
  const options = {
    help: flags.has("--help"),
    mutations: flags.has("--mutations"),
    preflight: flags.has("--preflight"),
    reconcile: flags.has("--reconcile"),
    spend: flags.has("--spend"),
    unlock: flags.has("--unlock"),
  };
  if (
    options.preflight &&
    (options.mutations || options.reconcile || options.spend || options.unlock)
  ) {
    throw new Error(
      "--preflight runs separately from mutation and recovery options",
    );
  }
  if (options.spend && !options.mutations) {
    throw new Error("--spend requires --mutations");
  }
  const exclusive = [options.reconcile, options.unlock].filter(Boolean).length;
  if (
    exclusive > 1 ||
    ((options.reconcile || options.unlock) && options.mutations)
  ) {
    throw new Error("--reconcile and --unlock run separately from --mutations");
  }
  return options;
}

function usage(): void {
  console.log(`Usage: pnpm test:pay-per-use -- [options]

Safe default: run the read-only contract preflight.

Options:
  --preflight   Run the read-only preflight explicitly
  --mutations   Create, inspect, and retire a disposable sub-account and agent key
  --spend       With --mutations, make one bounded vendor payment
  --reconcile   Reconcile and clean up an interrupted run; never starts another payment
  --unlock      Remove a verified stale journal lock
  --help        Show this help

Environment:
  PERFLO_ACCOUNT_KEY              Required account key; never logged or journaled
  PERFLO_API_BASE_URL             Default: ${DEFAULT_API_ORIGIN}
  PERFLO_LIVE_CONFIRMATION_CODE   Optional code for a held test payment; never journaled
  PERFLO_LIVE_JOURNAL             Default: ${DEFAULT_JOURNAL_PATH}
  PERFLO_LIVE_MAX_CHARGE          Default: ${DEFAULT_PAYMENT_MAX_CHARGE.amount}
  PERFLO_LIVE_VENDOR_SLUG         Default: ${DEFAULT_VENDOR_SLUG}
  PERFLO_OPENAPI_PATH             Default: openapi.json in this repository
  PERFLO_SDK_ENTRY                Default: dist/index.js in this repository
  PERFLO_SDK_PACKAGE_JSON         Package metadata for PERFLO_SDK_ENTRY
  PERFLO_EXPECTED_SDK_VERSION     Optional exact artifact-version assertion
`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}

function envelopeData(value: unknown): unknown {
  return isRecord(value) ? value.data : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

export function createSecretRedactor(initial: Array<string | undefined>): {
  add: (value: string | undefined) => void;
  redact: (value: string) => string;
} {
  const secrets = new Set(initial.filter((value): value is string => !!value));
  return {
    add: (value) => {
      if (value) secrets.add(value);
    },
    redact: (value) => {
      let redacted = value.replaceAll(/(Bearer\s+)[^\s,;]+/gi, "$1[redacted]");
      for (const secret of secrets) {
        redacted = redacted.replaceAll(secret, "[redacted]");
      }
      return redacted;
    },
  };
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  if (typeof error.code === "string") return error.code;
  return isRecord(error.error) && typeof error.error.code === "string"
    ? error.error.code
    : null;
}

function isUndeliveredRetrySafe503(
  error: unknown,
  response: Response | undefined,
): boolean {
  return (
    response?.status === 503 &&
    isRecord(error) &&
    isRecord(error.error) &&
    isRecord(error.error.details) &&
    error.error.details.retrySafe === true
  );
}

function requestId(value: unknown): string | undefined {
  if (!isRecord(value)) return;
  if (typeof value.request_id === "string") return value.request_id;
  if (isRecord(value.meta) && typeof value.meta.requestId === "string") {
    return value.meta.requestId;
  }
  return;
}

function responsePayload(result: SdkFieldResult): unknown {
  const status = result.response?.status;
  return status !== undefined && status >= 200 && status < 300
    ? result.data
    : result.error;
}

function exactSuccess(status: number): Array<ExpectedOutcome> {
  return [{ behavior: "success", code: null, status }];
}

function exactRefusal(status: number, code: string): Array<ExpectedOutcome> {
  return [{ behavior: "expected-refusal", code, status }];
}

export function matchExpectedOutcome(
  status: number | null,
  code: string | null,
  expected: Array<ExpectedOutcome>,
): ExpectedOutcome | undefined {
  return expected.find(
    (candidate) => candidate.status === status && candidate.code === code,
  );
}

function recordLine(record: OperationRecord): void {
  const state = ["success", "expected-refusal", "blocked"].includes(
    record.behavior,
  )
    ? "PASS"
    : "FAIL";
  const status = record.status === null ? "-" : String(record.status);
  console.log(
    `${state.padEnd(4)} ${record.operation} ${record.behavior} HTTP ${status}: ${record.detail}`,
  );
}

function addRecord(
  context: RunContext,
  record: OperationRecord,
): OperationRecord {
  const safeRecord = { ...record, detail: context.redact(record.detail) };
  context.records.push(safeRecord);
  recordLine(safeRecord);
  return safeRecord;
}

function blockOperation(
  context: RunContext,
  operation: OperationName,
  detail: string,
): OperationRecord {
  return addRecord(context, {
    behavior: "blocked",
    contractErrors: [],
    detail,
    errorCode: null,
    operation,
    status: null,
  });
}

async function invokeOperation(
  context: RunContext,
  operation: OperationName,
  request: () => PromiseLike<SdkFieldResult>,
  expected: Array<ExpectedOutcome>,
): Promise<InvocationResult> {
  context.invoked.add(operation);
  let result: SdkFieldResult;
  try {
    result = await request();
  } catch (error) {
    return {
      record: addRecord(context, {
        behavior: "request-failure",
        contractErrors: [],
        detail: error instanceof Error ? error.message : "request threw",
        errorCode: null,
        operation,
        status: null,
      }),
    };
  }

  const status = result.response?.status ?? null;
  const code = errorCode(result.error);
  let contractErrors: Array<string> = [];
  try {
    contractErrors = await context.validateResponse(operation, result);
  } catch (error) {
    contractErrors = [
      `contract validator failed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const match = matchExpectedOutcome(status, code, expected);
  const id = requestId(result.data) ?? requestId(result.error);
  const suffix = id ? ` request_id=${id}` : "";
  if (contractErrors.length > 0) {
    return {
      record: addRecord(context, {
        behavior: "contract-failure",
        contractErrors,
        detail: `${contractErrors.join("; ")}${suffix}`,
        errorCode: code,
        operation,
        status,
      }),
      result,
    };
  }
  if (!match) {
    return {
      record: addRecord(context, {
        behavior: "behavior-failure",
        contractErrors: [],
        detail: `unexpected status/code pair ${status}/${code ?? "none"}${suffix}`,
        errorCode: code,
        operation,
        status,
      }),
      result,
    };
  }
  return {
    record: addRecord(context, {
      behavior: match.behavior,
      contractErrors: [],
      detail: `${match.behavior === "success" ? "contract-valid response" : code}${suffix}`,
      errorCode: code,
      operation,
      status,
    }),
    result,
  };
}

function signal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function parseMoney(
  value: string | undefined,
  currency = "USD",
): PayPerUseMoney {
  const amount = value?.trim() || DEFAULT_PAYMENT_MAX_CHARGE.amount;
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
    throw new Error(
      "PERFLO_LIVE_MAX_CHARGE must be a positive decimal with at most six places",
    );
  }
  return { amount, currency };
}

async function hashSdkTree(packageRoot: string): Promise<string> {
  const files: Array<string> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(resolve(packageRoot, "dist"));
  files.push(resolve(packageRoot, "package.json"));
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path.slice(packageRoot.length));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function loadRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<Runtime> {
  const sdkEntry = resolve(
    environment.PERFLO_SDK_ENTRY?.trim() ||
      resolve(REPOSITORY_ROOT, "dist/index.js"),
  );
  const packageJsonPath = resolve(
    environment.PERFLO_SDK_PACKAGE_JSON?.trim() ||
      resolve(dirname(sdkEntry), "..", "package.json"),
  );
  const packageRoot = dirname(packageJsonPath);
  const distRoot = resolve(packageRoot, "dist");
  const [realEntry, realDistRoot] = await Promise.all([
    realpath(sdkEntry),
    realpath(distRoot),
  ]);
  const entryWithinDist = relative(realDistRoot, realEntry);
  if (
    entryWithinDist === ".." ||
    entryWithinDist.startsWith(`..${sep}`) ||
    isAbsolute(entryWithinDist)
  ) {
    throw new Error(
      "PERFLO_SDK_ENTRY must belong to the selected package dist tree",
    );
  }
  const openapiPath = resolve(
    environment.PERFLO_OPENAPI_PATH?.trim() ||
      resolve(REPOSITORY_ROOT, "openapi.json"),
  );
  const [sdk, sdkEntrySource, packageSource, openapiSource, sdkTreeSha256] =
    await Promise.all([
      import(pathToFileURL(sdkEntry).href) as Promise<SdkModule>,
      readFile(sdkEntry, "utf8"),
      readFile(packageJsonPath, "utf8"),
      readFile(openapiPath, "utf8"),
      hashSdkTree(packageRoot),
    ]);
  const packageJson: unknown = JSON.parse(packageSource);
  const packageName = readString(packageJson, "name");
  const packageVersion = readString(packageJson, "version");
  if (packageName !== "@perflo/finance-sdk") {
    throw new Error(
      `${packageJsonPath} names ${packageName ?? "no package"}, expected @perflo/finance-sdk`,
    );
  }
  if (!packageVersion) {
    throw new Error(`${packageJsonPath} has no package version`);
  }
  const expectedVersion = environment.PERFLO_EXPECTED_SDK_VERSION?.trim();
  if (expectedVersion && packageVersion !== expectedVersion) {
    throw new Error(
      `SDK artifact is ${packageVersion}, expected ${expectedVersion}`,
    );
  }
  return {
    entrySha256: createHash("sha256").update(sdkEntrySource).digest("hex"),
    openapi: JSON.parse(openapiSource) as OpenApiDocument,
    openapiPath,
    openapiSha256: createHash("sha256").update(openapiSource).digest("hex"),
    openapiSource,
    packageName,
    packageVersion,
    sdk,
    sdkTreeSha256,
  };
}

export function inventoryOperations(
  sdk: SdkModule,
  openapi: OpenApiDocument,
): Array<string> {
  const planned = new Set(Object.keys(OPERATION_ROUTES));
  const exported = new Set(
    Object.entries(sdk)
      .filter(
        ([name, value]) =>
          /^payPerUse[A-Z]/.test(name) && typeof value === "function",
      )
      .map(([name]) => name),
  );
  const errors = [
    ...[...planned]
      .filter((name) => !exported.has(name))
      .map((name) => `missing SDK export ${name}`),
    ...[...exported]
      .filter((name) => !planned.has(name))
      .map((name) => `unplanned SDK export ${name}`),
  ];
  for (const [name, [method, path, operationId]] of Object.entries(
    OPERATION_ROUTES,
  )) {
    const operation = openapi.paths[path]?.[method];
    if (operation?.operationId !== operationId) {
      errors.push(
        `${name} expects ${operationId} at ${method.toUpperCase()} ${path}, found ${operation?.operationId ?? "none"}`,
      );
    }
  }
  const expectedOperationIds = new Set<string>(
    Object.values(OPERATION_ROUTES).map(([, , operationId]) => operationId),
  );
  const documentedOperationIds = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const method of HTTP_OPERATION_METHODS) {
      const operationId = pathItem[method]?.operationId;
      if (!operationId?.startsWith("pay_per_use_")) continue;
      const previous = documentedOperationIds.get(operationId);
      if (previous) {
        errors.push(
          `duplicate OpenAPI operationId ${operationId} at ${previous} and ${method.toUpperCase()} ${path}`,
        );
      }
      documentedOperationIds.set(
        operationId,
        `${method.toUpperCase()} ${path}`,
      );
    }
  }
  for (const [operationId, location] of documentedOperationIds) {
    if (!expectedOperationIds.has(operationId)) {
      errors.push(`unplanned OpenAPI operation ${operationId} at ${location}`);
    }
  }
  for (const operationId of expectedOperationIds) {
    if (!documentedOperationIds.has(operationId)) {
      errors.push(`missing OpenAPI operation ${operationId}`);
    }
  }
  return errors;
}

function resultRows<T>(result: SdkFieldResult | undefined): Array<T> {
  return asArray(envelopeData(result?.data)) as Array<T>;
}

async function runPreflight(context: RunContext): Promise<PreflightState> {
  const account = await invokeOperation(
    context,
    "payPerUseGetAccount",
    () =>
      context.sdk.payPerUseGetAccount({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const accountData = envelopeData(account.result?.data);
  const accountId = readString(accountData, "accountId");
  const spendable =
    isRecord(accountData) && isRecord(accountData.spendable)
      ? accountData.spendable
      : undefined;
  const policy =
    isRecord(accountData) && isRecord(accountData.policy)
      ? accountData.policy
      : undefined;

  await invokeOperation(
    context,
    "payPerUseGetAccountKey",
    () =>
      context.sdk.payPerUseGetAccountKey({
        client: context.accountClient,
        signal: signal(),
      }),
    exactRefusal(403, "ACCOUNT_KEY_REQUIRED"),
  );

  const capabilities = await invokeOperation(
    context,
    "payPerUseListCapabilities",
    () =>
      context.sdk.payPerUseListCapabilities({
        client: context.accountClient,
        query: { flat: true, include: "vendors" },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const capabilitySlug = readString(
    resultRows<JsonRecord>(capabilities.result)[0],
    "slug",
  );
  if (capabilitySlug) {
    await invokeOperation(
      context,
      "payPerUseGetCapability",
      () =>
        context.sdk.payPerUseGetCapability({
          client: context.accountClient,
          path: { slug: capabilitySlug },
          signal: signal(),
        }),
      exactSuccess(200),
    );
  } else {
    blockOperation(
      context,
      "payPerUseGetCapability",
      "capability list supplied no slug",
    );
  }

  await invokeOperation(
    context,
    "payPerUseSearchVendors",
    () =>
      context.sdk.payPerUseSearchVendors({
        client: context.accountClient,
        query: { limit: 10, query: "web search" },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  await invokeOperation(
    context,
    "payPerUseSearchVendorsWithBody",
    () =>
      context.sdk.payPerUseSearchVendorsWithBody({
        body: { limit: 10, query: "web search" },
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const vendorResult = await invokeOperation(
    context,
    "payPerUseGetVendor",
    () =>
      context.sdk.payPerUseGetVendor({
        client: context.accountClient,
        path: { slug: context.vendorSlug },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const vendorValue = envelopeData(vendorResult.result?.data);
  const vendor = isRecord(vendorValue) ? vendorValue : undefined;

  const subAccountsResult = await invokeOperation(
    context,
    "payPerUseListSubAccounts",
    () =>
      context.sdk.payPerUseListSubAccounts({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const agentKeysResult = await invokeOperation(
    context,
    "payPerUseListAgentKeys",
    () =>
      context.sdk.payPerUseListAgentKeys({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const resources = await invokeOperation(
    context,
    "payPerUseListResources",
    () =>
      context.sdk.payPerUseListResources({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const resourceId = readString(
    resultRows<JsonRecord>(resources.result)[0],
    "id",
  );
  if (resourceId) {
    await invokeOperation(
      context,
      "payPerUseGetResource",
      () =>
        context.sdk.payPerUseGetResource({
          client: context.accountClient,
          path: { id: resourceId },
          signal: signal(),
        }),
      exactSuccess(200),
    );
  } else {
    blockOperation(
      context,
      "payPerUseGetResource",
      "account has no resource to read",
    );
  }

  const transactions = await invokeOperation(
    context,
    "payPerUseListTransactions",
    () =>
      context.sdk.payPerUseListTransactions({
        client: context.accountClient,
        query: { limit: 10, offset: 0 },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const transactionId = readString(
    resultRows<JsonRecord>(transactions.result)[0],
    "id",
  );
  if (transactionId) {
    await invokeOperation(
      context,
      "payPerUseGetTransaction",
      () =>
        context.sdk.payPerUseGetTransaction({
          client: context.accountClient,
          path: { id: transactionId },
          signal: signal(),
        }),
      exactSuccess(200),
    );
  } else {
    blockOperation(
      context,
      "payPerUseGetTransaction",
      "account has no transaction to read",
    );
  }

  const failures = context.records
    .filter((record) =>
      ["behavior-failure", "contract-failure", "request-failure"].includes(
        record.behavior,
      ),
    )
    .map((record) => `${record.operation}: ${record.detail}`);
  if (!accountId) failures.push("account response supplied no accountId");
  if (
    spendable?.currency !== context.maxCharge.currency ||
    typeof spendable.amount !== "string" ||
    Number(spendable.amount) < Number(context.maxCharge.amount)
  ) {
    failures.push(
      "account spendable balance does not cover the configured maximum charge",
    );
  }
  if (policy?.status !== "active" || policy.settlementGrant !== "active") {
    failures.push("account spending policy or settlement grant is not active");
  }
  const vendorMaxCharge = isRecord(vendor?.maxChargePerCall)
    ? vendor.maxChargePerCall
    : undefined;
  if (
    !vendor ||
    vendor.payable !== true ||
    vendor.pricingUnit !== "call" ||
    vendor.requiresConfirmation !== false ||
    vendor.isResourceStorage !== false ||
    vendorMaxCharge?.currency !== context.maxCharge.currency ||
    typeof vendorMaxCharge.amount !== "string" ||
    Number(vendorMaxCharge.amount) > Number(context.maxCharge.amount)
  ) {
    failures.push(
      "vendor is not a contract-valid payable per-call, no-confirmation, non-resource service",
    );
  }
  return {
    accountId,
    agentKeys: resultRows<PayPerUseAgentKeyMetadata>(agentKeysResult.result),
    failures,
    subAccounts: resultRows<PayPerUseSubAccountListItem>(
      subAccountsResult.result,
    ),
    vendor,
  };
}

export async function writeJournal(
  path: string,
  journal: LiveJournal,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(resolve(path)), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isJournalResource(value: unknown): value is JournalResource {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    ["absent", "active", "dispatching", "retired", "uncertain"].includes(
      String(value.phase),
    )
  );
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isLiveJournal(value: unknown): value is LiveJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !["active", "complete", "unresolved"].includes(String(value.status)) ||
    typeof value.runId !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.label !== "string" ||
    typeof value.updatedLabel !== "string" ||
    typeof value.keyName !== "string" ||
    !isJournalResource(value.agentKey) ||
    !isJournalResource(value.subAccount) ||
    !isRecord(value.context) ||
    typeof value.context.accountId !== "string" ||
    typeof value.context.apiOrigin !== "string" ||
    typeof value.context.entrySha256 !== "string" ||
    typeof value.context.openapiSha256 !== "string" ||
    typeof value.context.sdkVersion !== "string" ||
    typeof value.context.sdkTreeSha256 !== "string" ||
    !isRecord(value.baseline) ||
    !isStringArray(value.baseline.agentKeyIds) ||
    !isStringArray(value.baseline.subAccountIds) ||
    !isRecord(value.payment) ||
    !isRecord(value.payment.body) ||
    typeof value.payment.idempotencyKey !== "string" ||
    typeof value.payment.slug !== "string" ||
    ![
      "absent",
      "confirmation_required",
      "dispatching",
      "failed",
      "succeeded",
      "uncertain",
    ].includes(String(value.payment.phase))
  ) {
    return false;
  }
  return true;
}

export async function readJournal(
  path: string,
): Promise<LiveJournal | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isLiveJournal(value)) {
      throw new Error(`${path} has an invalid journal shape`);
    }
    return value;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
}

export async function withJournalLock<T>(
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`${lockPath} exists; another run may be active`);
    }
    throw error;
  });
  const removeAtExit = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      return;
    }
  };
  process.once("exit", removeAtExit);
  try {
    await lock.writeFile(
      `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })}\n`,
    );
    return await task();
  } finally {
    try {
      await lock.close();
      await unlink(lockPath).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      });
    } finally {
      process.removeListener("exit", removeAtExit);
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
}

export async function unlockJournal(path: string): Promise<void> {
  const lockPath = `${path}.lock`;
  const [source, metadata] = await Promise.all([
    readFile(lockPath, "utf8"),
    stat(lockPath),
  ]).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [undefined, undefined] as const;
    }
    throw error;
  });
  if (!source || !metadata) {
    console.log(`PASS ${lockPath} does not exist`);
    return;
  }
  let pid: number | undefined;
  try {
    const value: unknown = JSON.parse(source);
    if (isRecord(value) && Number.isSafeInteger(value.pid)) {
      pid = value.pid as number;
    }
  } catch {
    pid = undefined;
  }
  if (pid !== undefined && processExists(pid)) {
    throw new Error(`${lockPath} belongs to active process ${pid}`);
  }
  if (Date.now() - metadata.mtimeMs < 60_000) {
    throw new Error(
      `${lockPath} is less than one minute old; wait before unlocking`,
    );
  }
  await unlink(lockPath);
  console.log(`PASS removed stale lock ${lockPath}`);
}

export function newJournal(
  context: JournalContext,
  preflight: PreflightState,
  maxCharge: PayPerUseMoney,
  slug: string,
): LiveJournal {
  const runId = randomUUID();
  const marker = runId.slice(0, 12);
  return {
    agentKey: { phase: "absent" },
    baseline: {
      agentKeyIds: preflight.agentKeys.map((key) => key.id),
      subAccountIds: preflight.subAccounts.map((account) => account.id),
    },
    context,
    keyName: `sdk-live-${marker}`,
    label: `sdk-live-${marker}`,
    payment: {
      body: {
        input: { mode: "fast", query: "OpenAI official website" },
        maxCharge,
      },
      charged: null,
      idempotencyKey: randomUUID(),
      phase: "absent",
      slug,
    },
    runId,
    startedAt: new Date().toISOString(),
    status: "active",
    subAccount: { phase: "absent" },
    updatedLabel: `sdk-live-${marker}-updated`,
    version: 1,
  };
}

export function mutationsAllowed(preflight: PreflightState): boolean {
  return preflight.accountId !== undefined && preflight.failures.length === 0;
}

function isDefinitiveFailure(result: InvocationResult): boolean {
  const status = result.record.status;
  return status !== null && status >= 400 && status < 500;
}

async function listSubAccounts(
  context: RunContext,
): Promise<Array<PayPerUseSubAccountListItem> | undefined> {
  const read = await invokeOperation(
    context,
    "payPerUseListSubAccounts",
    () =>
      context.sdk.payPerUseListSubAccounts({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  return read.record.behavior === "success"
    ? resultRows<PayPerUseSubAccountListItem>(read.result)
    : undefined;
}

async function listAgentKeys(
  context: RunContext,
): Promise<Array<PayPerUseAgentKeyMetadata> | undefined> {
  const read = await invokeOperation(
    context,
    "payPerUseListAgentKeys",
    () =>
      context.sdk.payPerUseListAgentKeys({
        client: context.accountClient,
        signal: signal(),
      }),
    exactSuccess(200),
  );
  return read.record.behavior === "success"
    ? resultRows<PayPerUseAgentKeyMetadata>(read.result)
    : undefined;
}

async function recoverSubAccountId(
  context: RunContext,
  journal: LiveJournal,
): Promise<string | undefined> {
  const rows = await listSubAccounts(context);
  if (!rows) return;
  const matches = rows.filter(
    (row) =>
      row.label === journal.label &&
      !journal.baseline.subAccountIds.includes(row.id),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

async function recoverAgentKeyId(
  context: RunContext,
  journal: LiveJournal,
): Promise<string | undefined> {
  const rows = await listAgentKeys(context);
  if (!rows) return;
  const matches = rows.filter(
    (row) =>
      row.name === journal.keyName &&
      (journal.subAccount.id === undefined ||
        row.subAccount.id === journal.subAccount.id) &&
      !journal.baseline.agentKeyIds.includes(row.id),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

async function retireAgentKey(
  context: RunContext,
  journalPath: string,
  journal: LiveJournal,
): Promise<boolean> {
  const id = journal.agentKey.id ?? (await recoverAgentKeyId(context, journal));
  if (!id) return journal.agentKey.phase === "absent";
  journal.agentKey.id = id;
  const currentKeys = await listAgentKeys(context);
  if (!currentKeys) {
    journal.agentKey.phase = "uncertain";
    await writeJournal(journalPath, journal);
    return false;
  }
  const existing = currentKeys.find((candidate) => candidate.id === id);
  if (existing?.revokedAt) {
    journal.agentKey.phase = "retired";
    await writeJournal(journalPath, journal);
    return true;
  }
  journal.agentKey.phase = "dispatching";
  await writeJournal(journalPath, journal);
  await invokeOperation(
    context,
    "payPerUseRevokeAgentKey",
    () =>
      context.sdk.payPerUseRevokeAgentKey({
        client: context.accountClient,
        path: { id },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const verifiedKeys = await listAgentKeys(context);
  const row = verifiedKeys?.find((candidate) => candidate.id === id);
  if (row?.revokedAt) {
    journal.agentKey.phase = "retired";
    await writeJournal(journalPath, journal);
    return true;
  }
  journal.agentKey.phase = "uncertain";
  await writeJournal(journalPath, journal);
  return false;
}

async function retireSubAccount(
  context: RunContext,
  journalPath: string,
  journal: LiveJournal,
): Promise<boolean> {
  const id =
    journal.subAccount.id ?? (await recoverSubAccountId(context, journal));
  if (!id) return journal.subAccount.phase === "absent";
  journal.subAccount.id = id;
  const currentSubAccounts = await listSubAccounts(context);
  if (!currentSubAccounts) {
    journal.subAccount.phase = "uncertain";
    await writeJournal(journalPath, journal);
    return false;
  }
  const existing = currentSubAccounts.find((candidate) => candidate.id === id);
  if (existing?.status === "disabled") {
    journal.subAccount.phase = "retired";
    await writeJournal(journalPath, journal);
    return true;
  }
  journal.subAccount.phase = "dispatching";
  await writeJournal(journalPath, journal);
  await invokeOperation(
    context,
    "payPerUseDisableSubAccount",
    () =>
      context.sdk.payPerUseDisableSubAccount({
        client: context.accountClient,
        path: { id },
        signal: signal(),
      }),
    exactSuccess(200),
  );
  const verifiedSubAccounts = await listSubAccounts(context);
  const row = verifiedSubAccounts?.find((candidate) => candidate.id === id);
  if (row?.status === "disabled") {
    journal.subAccount.phase = "retired";
    await writeJournal(journalPath, journal);
    return true;
  }
  journal.subAccount.phase = "uncertain";
  await writeJournal(journalPath, journal);
  return false;
}

function paymentResolved(journal: LiveJournal): boolean {
  return ["absent", "failed", "succeeded"].includes(journal.payment.phase);
}

type FinancialViewState = "failed" | "open" | "succeeded" | "uncertain";

export function classifyFinancialView(value: {
  chargeIsFinal: boolean;
  status: string;
  terminal: boolean;
}): FinancialViewState {
  if (!value.terminal) return "open";
  if (!value.chargeIsFinal) return "uncertain";
  return value.status === "succeeded" ? "succeeded" : "failed";
}

async function pollOwnTransaction(
  context: RunContext,
  transactionId: string,
): Promise<PayPerUseTransactionView | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const read = await invokeOperation(
      context,
      "payPerUseGetTransaction",
      () =>
        context.sdk.payPerUseGetTransaction({
          client: context.accountClient,
          path: { id: transactionId },
          signal: signal(),
        }),
      exactSuccess(200),
    );
    const value = envelopeData(read.result?.data);
    if (!isRecord(value) || read.record.behavior !== "success") return;
    const transaction = value as unknown as PayPerUseTransactionView;
    if (transaction.id !== transactionId) return;
    if (transaction.terminal) return transaction;
    await delay(2_000);
  }
  addRecord(context, {
    behavior: "behavior-failure",
    contractErrors: [],
    detail: "transaction did not become terminal before the read deadline",
    errorCode: null,
    operation: "payPerUseGetTransaction",
    status: null,
  });
  return;
}

export async function runPayment(
  context: RunContext,
  journalPath: string,
  journal: LiveJournal,
  agentClient: PerfloClient,
  confirmationCode: string | undefined,
): Promise<void> {
  journal.payment.phase = "dispatching";
  journal.payment.dispatchedAt = new Date().toISOString();
  await writeJournal(journalPath, journal);
  context.invoked.add("payPerUsePayVendor");
  const outcome = await context.sdk.payVendorSafely({
    attemptTimeoutMs: 40_000,
    attempts: 4,
    body: journal.payment.body as never,
    client: agentClient,
    deadlineMs: 180_000,
    idempotencyKey: journal.payment.idempotencyKey,
    readTimeoutMs: 60_000,
    slug: journal.payment.slug,
  });

  if (outcome.error !== undefined || outcome.data === undefined) {
    const result = {
      error: outcome.error,
      response: outcome.response,
    } satisfies SdkFieldResult;
    const contractErrors = outcome.response
      ? await context.validateResponse("payPerUsePayVendor", result)
      : [];
    addRecord(context, {
      behavior:
        contractErrors.length > 0 ? "contract-failure" : "behavior-failure",
      contractErrors,
      detail:
        contractErrors.join("; ") ||
        `payment failed with ${errorCode(outcome.error) ?? "unknown error"}`,
      errorCode: errorCode(outcome.error),
      operation: "payPerUsePayVendor",
      status: outcome.response?.status ?? null,
    });
    journal.payment.phase =
      contractErrors.length === 0 &&
      ((outcome.response && outcome.response.status < 500) ||
        isUndeliveredRetrySafe503(outcome.error, outcome.response))
        ? "failed"
        : "uncertain";
    journal.payment.charged =
      journal.payment.phase === "failed" ? null : "unknown";
    context.charged = journal.payment.charged;
    await writeJournal(journalPath, journal);
    return;
  }

  const result = outcome.data;
  if (result.kind === "unknown") {
    const transaction = result.transactionId
      ? await pollOwnTransaction(context, result.transactionId)
      : undefined;
    const transactionState = transaction
      ? classifyFinancialView(transaction)
      : undefined;
    const succeeded = transactionState === "succeeded";
    addRecord(context, {
      behavior: succeeded ? "success" : "behavior-failure",
      contractErrors: [],
      detail: succeeded
        ? "unknown pay response reconciled through its transaction"
        : "payment outcome is unknown; do not start another payment",
      errorCode: errorCode(result.lastError),
      operation: "payPerUsePayVendor",
      status: null,
    });
    journal.payment.phase =
      transactionState === "succeeded" || transactionState === "failed"
        ? transactionState
        : "uncertain";
    journal.payment.charged = "unknown";
    context.charged = "unknown";
    journal.payment.transactionId = result.transactionId;
    await writeJournal(journalPath, journal);
    return;
  }

  if (result.kind === "recovered") {
    const transaction = await pollOwnTransaction(
      context,
      result.transaction.id,
    );
    const transactionState = transaction
      ? classifyFinancialView(transaction)
      : undefined;
    const succeeded = transactionState === "succeeded";
    addRecord(context, {
      behavior: succeeded ? "success" : "behavior-failure",
      contractErrors: [],
      detail: succeeded
        ? "terminal payment recovered"
        : transaction
          ? `recovered ${transaction.status}`
          : "recovered transaction failed contract validation",
      errorCode: null,
      operation: "payPerUsePayVendor",
      status: null,
    });
    journal.payment.phase =
      transactionState === "succeeded" || transactionState === "failed"
        ? transactionState
        : "uncertain";
    journal.payment.charged = "unknown";
    context.charged = "unknown";
    journal.payment.transactionId = result.transaction.id;
    await writeJournal(journalPath, journal);
    return;
  }

  const envelope = result.data;
  const validationResult = {
    data: envelope,
    response: outcome.response,
  } satisfies SdkFieldResult;
  const contractErrors = outcome.response
    ? await context.validateResponse("payPerUsePayVendor", validationResult)
    : ["payment response is absent"];
  const payment = envelope.data;
  let finalPayment = payment;
  journal.payment.transactionId = payment.transactionId;
  if (result.kind === "confirmation_required") {
    addRecord(context, {
      behavior: contractErrors.length > 0 ? "contract-failure" : "success",
      contractErrors,
      detail: contractErrors.join("; ") || "payment is held and uncharged",
      errorCode: null,
      operation: "payPerUsePayVendor",
      status: outcome.response?.status ?? null,
    });
    journal.payment.phase = "confirmation_required";
    journal.payment.charged = null;
    context.charged = null;
    await writeJournal(journalPath, journal);
    if (contractErrors.length > 0) {
      journal.payment.phase = "uncertain";
      journal.payment.charged = "unknown";
      context.charged = "unknown";
      await writeJournal(journalPath, journal);
      return;
    }
    if (!confirmationCode) {
      blockOperation(
        context,
        "payPerUseConfirmPayment",
        "payment needs PERFLO_LIVE_CONFIRMATION_CODE",
      );
      return;
    }
    const confirmed = await invokeOperation(
      context,
      "payPerUseConfirmPayment",
      () =>
        context.sdk.payPerUseConfirmPayment({
          body: { code: confirmationCode },
          client: agentClient,
          path: { id: payment.transactionId },
          signal: signal(),
        }),
      exactSuccess(200),
    );
    const confirmedPayment = envelopeData(confirmed.result?.data);
    if (
      confirmed.record.behavior !== "success" ||
      !isRecord(confirmedPayment)
    ) {
      journal.payment.phase = "uncertain";
      journal.payment.charged = "unknown";
      context.charged = "unknown";
      await writeJournal(journalPath, journal);
      return;
    }
    finalPayment = confirmedPayment as typeof payment;
    journal.payment.transactionId = finalPayment.transactionId;
  } else {
    blockOperation(
      context,
      "payPerUseConfirmPayment",
      "selected vendor did not require confirmation",
    );
  }

  const transaction = await pollOwnTransaction(
    context,
    finalPayment.transactionId,
  );
  const paymentState =
    contractErrors.length > 0
      ? "uncertain"
      : classifyFinancialView(finalPayment);
  const transactionState = transaction
    ? classifyFinancialView(transaction)
    : undefined;
  const transactionContradictsPayment =
    (paymentState === "succeeded" || paymentState === "failed") &&
    (transactionState === "succeeded" || transactionState === "failed") &&
    paymentState !== transactionState;
  const resolvedState: FinancialViewState = transactionContradictsPayment
    ? "uncertain"
    : transactionState === "uncertain"
      ? "uncertain"
      : transactionState === "succeeded" || transactionState === "failed"
        ? transactionState
        : paymentState === "succeeded" || paymentState === "failed"
          ? paymentState
          : paymentState === "uncertain"
            ? "uncertain"
            : "open";
  const succeeded = resolvedState === "succeeded";
  addRecord(context, {
    behavior:
      contractErrors.length > 0
        ? "contract-failure"
        : succeeded
          ? "success"
          : "behavior-failure",
    contractErrors,
    detail:
      contractErrors.join("; ") ||
      (succeeded
        ? paymentState === "succeeded"
          ? transactionState === "succeeded"
            ? "terminal payment and transaction succeeded"
            : "terminal payment succeeded; transaction verification was unavailable"
          : "terminal transaction completed the open payment"
        : resolvedState === "failed"
          ? `payment ended ${paymentState === "failed" ? finalPayment.status : transaction?.status}`
          : transactionContradictsPayment
            ? "terminal payment and transaction results contradict"
            : resolvedState === "uncertain"
              ? "payment reached a terminal but non-final or inconsistent money state"
              : "payment remained open after the transaction-read deadline"),
    errorCode: null,
    operation: "payPerUsePayVendor",
    status: outcome.response?.status ?? null,
  });
  journal.payment.phase =
    resolvedState === "succeeded" || resolvedState === "failed"
      ? resolvedState
      : "uncertain";
  journal.payment.charged =
    contractErrors.length === 0 &&
    paymentState !== "open" &&
    paymentState !== "uncertain" &&
    finalPayment.charged
      ? finalPayment.charged
      : "unknown";
  context.charged = journal.payment.charged;
  await writeJournal(journalPath, journal);
}

export async function runMutationWorkflow(
  context: RunContext,
  preflight: PreflightState,
  runtime: Runtime,
  options: RunOptions,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (!mutationsAllowed(preflight)) {
    for (const operation of Object.keys(
      OPERATION_ROUTES,
    ) as Array<OperationName>) {
      if (
        !READ_ONLY_OPERATIONS.has(operation) &&
        !context.invoked.has(operation)
      ) {
        blockOperation(
          context,
          operation,
          "preflight failed; no mutation was dispatched",
        );
      }
    }
    return;
  }

  const maxCharge = context.maxCharge;
  const slug = context.vendorSlug;
  const invalidClient = context.sdk.createPerfloClient({
    baseUrl: context.apiOrigin,
    token: `invalid-${randomUUID()}`,
  });
  const accountKeyCreateProbe = await invokeOperation(
    context,
    "payPerUseCreateAccountKey",
    () =>
      context.sdk.payPerUseCreateAccountKey({
        body: { name: `sdk-live-probe-${randomUUID().slice(0, 12)}` },
        client: invalidClient,
        signal: signal(),
      }),
    exactRefusal(401, "UNAUTHENTICATED"),
  );
  const accountKeyRevokeProbe = await invokeOperation(
    context,
    "payPerUseRevokeAccountKey",
    () =>
      context.sdk.payPerUseRevokeAccountKey({
        client: invalidClient,
        signal: signal(),
      }),
    exactRefusal(401, "UNAUTHENTICATED"),
  );
  if (
    accountKeyCreateProbe.record.behavior !== "expected-refusal" ||
    accountKeyRevokeProbe.record.behavior !== "expected-refusal"
  ) {
    for (const operation of Object.keys(
      OPERATION_ROUTES,
    ) as Array<OperationName>) {
      if (
        !READ_ONLY_OPERATIONS.has(operation) &&
        !context.invoked.has(operation)
      ) {
        blockOperation(
          context,
          operation,
          "account-key refusal probes failed; no authorized mutation was dispatched",
        );
      }
    }
    return;
  }
  const journalPath = resolve(
    environment.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH,
  );
  await withJournalLock(journalPath, async () => {
    const previous = await readJournal(journalPath);
    if (previous && previous.status !== "complete") {
      throw new Error(`${journalPath} is unresolved; run with --reconcile`);
    }
    const journal = newJournal(
      {
        accountId: preflight.accountId as string,
        apiOrigin: context.apiOrigin,
        entrySha256: runtime.entrySha256,
        openapiSha256: runtime.openapiSha256,
        sdkVersion: runtime.packageVersion,
        sdkTreeSha256: runtime.sdkTreeSha256,
      },
      preflight,
      maxCharge,
      slug,
    );
    await writeJournal(journalPath, journal);

    let agentSecret: string | undefined;
    try {
      journal.subAccount.phase = "dispatching";
      await writeJournal(journalPath, journal);
      const createdSubAccount = await invokeOperation(
        context,
        "payPerUseCreateSubAccount",
        () =>
          context.sdk.payPerUseCreateSubAccount({
            body: {
              label: journal.label,
              limits: { hourly: maxCharge, total: maxCharge },
            },
            client: context.accountClient,
            signal: signal(),
          }),
        exactSuccess(201),
      );
      journal.subAccount.id = readString(
        envelopeData(createdSubAccount.result?.data),
        "id",
      );
      if (!journal.subAccount.id && !isDefinitiveFailure(createdSubAccount)) {
        journal.subAccount.id = await recoverSubAccountId(context, journal);
      }
      if (
        !journal.subAccount.id ||
        createdSubAccount.record.behavior !== "success"
      ) {
        journal.subAccount.phase = journal.subAccount.id
          ? "active"
          : isDefinitiveFailure(createdSubAccount)
            ? "absent"
            : "uncertain";
        journal.status = "unresolved";
        await writeJournal(journalPath, journal);
        return;
      }
      journal.subAccount.phase = "active";
      await writeJournal(journalPath, journal);

      const readSubAccount = await invokeOperation(
        context,
        "payPerUseGetSubAccount",
        () =>
          context.sdk.payPerUseGetSubAccount({
            client: context.accountClient,
            path: { id: journal.subAccount.id as string },
            signal: signal(),
          }),
        exactSuccess(200),
      );
      if (readSubAccount.record.behavior !== "success") {
        journal.status = "unresolved";
        await writeJournal(journalPath, journal);
        return;
      }
      const updated = await invokeOperation(
        context,
        "payPerUseUpdateSubAccount",
        () =>
          context.sdk.payPerUseUpdateSubAccount({
            body: { label: journal.updatedLabel },
            client: context.accountClient,
            path: { id: journal.subAccount.id as string },
            signal: signal(),
          }),
        exactSuccess(200),
      );
      if (updated.record.behavior !== "success") {
        journal.status = "unresolved";
        await writeJournal(journalPath, journal);
        return;
      }

      journal.agentKey.phase = "dispatching";
      await writeJournal(journalPath, journal);
      const createdAgentKey = await invokeOperation(
        context,
        "payPerUseCreateAgentKey",
        () =>
          context.sdk.payPerUseCreateAgentKey({
            body: {
              name: journal.keyName,
              subAccountId: journal.subAccount.id as string,
            },
            client: context.accountClient,
            signal: signal(),
          }),
        exactSuccess(201),
      );
      const createdKeyData = envelopeData(createdAgentKey.result?.data);
      journal.agentKey.id = readString(createdKeyData, "id");
      agentSecret = readString(createdKeyData, "key");
      context.addSecret(agentSecret);
      if (!journal.agentKey.id && !isDefinitiveFailure(createdAgentKey)) {
        journal.agentKey.id = await recoverAgentKeyId(context, journal);
      }
      if (
        !journal.agentKey.id ||
        !agentSecret ||
        createdAgentKey.record.behavior !== "success"
      ) {
        journal.agentKey.phase = journal.agentKey.id
          ? "active"
          : isDefinitiveFailure(createdAgentKey)
            ? "absent"
            : "uncertain";
        journal.status = "unresolved";
        await writeJournal(journalPath, journal);
        return;
      }
      journal.agentKey.phase = "active";
      await writeJournal(journalPath, journal);

      const agentClient = context.sdk.createPerfloClient({
        baseUrl: context.apiOrigin,
        token: agentSecret,
      });
      const callerKey = await invokeOperation(
        context,
        "payPerUseGetCallerAgentKey",
        () =>
          context.sdk.payPerUseGetCallerAgentKey({
            client: agentClient,
            signal: signal(),
          }),
        exactSuccess(200),
      );
      const bulkDeletion = await invokeOperation(
        context,
        "payPerUseRejectBulkSubAccountDeletion",
        () =>
          context.sdk.payPerUseRejectBulkSubAccountDeletion({
            client: agentClient,
            signal: signal(),
          }),
        exactRefusal(405, "METHOD_NOT_ALLOWED"),
      );
      if (
        callerKey.record.behavior !== "success" ||
        bulkDeletion.record.behavior !== "expected-refusal"
      ) {
        blockOperation(
          context,
          "payPerUsePayVendor",
          "agent-key verification failed; no payment was dispatched",
        );
        blockOperation(
          context,
          "payPerUseConfirmPayment",
          "agent-key verification failed; no payment was dispatched",
        );
        return;
      }

      if (options.spend) {
        await runPayment(
          context,
          journalPath,
          journal,
          agentClient,
          environment.PERFLO_LIVE_CONFIRMATION_CODE?.trim(),
        );
      } else {
        blockOperation(
          context,
          "payPerUsePayVendor",
          "--spend was not supplied",
        );
        blockOperation(
          context,
          "payPerUseConfirmPayment",
          "--spend was not supplied",
        );
      }
    } finally {
      const keyRetired = await retireAgentKey(context, journalPath, journal);
      const subAccountRetired = paymentResolved(journal)
        ? await retireSubAccount(context, journalPath, journal)
        : false;
      journal.status =
        keyRetired && subAccountRetired ? "complete" : "unresolved";
      await writeJournal(journalPath, journal);
      context.journalStatus = journal.status;
    }
  });
}

export async function reconcileRun(
  context: RunContext,
  runtime: Runtime,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const journalPath = resolve(
    environment.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH,
  );
  await withJournalLock(journalPath, async () => {
    const journal = await readJournal(journalPath);
    if (!journal) throw new Error(`${journalPath} does not exist`);
    if (journal.status === "complete") {
      context.journalStatus = "complete";
      console.log("PASS journal is already complete");
      return;
    }
    if (
      journal.context.apiOrigin !== context.apiOrigin ||
      journal.context.entrySha256 !== runtime.entrySha256 ||
      journal.context.openapiSha256 !== runtime.openapiSha256 ||
      journal.context.sdkVersion !== runtime.packageVersion ||
      journal.context.sdkTreeSha256 !== runtime.sdkTreeSha256
    ) {
      throw new Error(
        "journal context does not match this SDK, contract, or origin",
      );
    }
    const account = await invokeOperation(
      context,
      "payPerUseGetAccount",
      () =>
        context.sdk.payPerUseGetAccount({
          client: context.accountClient,
          signal: signal(),
        }),
      exactSuccess(200),
    );
    if (
      account.record.behavior !== "success" ||
      readString(envelopeData(account.result?.data), "accountId") !==
        journal.context.accountId
    ) {
      throw new Error("journal belongs to a different or unreadable account");
    }
    journal.subAccount.id ??= await recoverSubAccountId(context, journal);
    journal.agentKey.id ??= await recoverAgentKeyId(context, journal);
    if (
      !paymentResolved(journal) &&
      journal.payment.dispatchedAt &&
      journal.subAccount.id
    ) {
      let transaction = journal.payment.transactionId
        ? await pollOwnTransaction(context, journal.payment.transactionId)
        : undefined;
      if (!journal.payment.transactionId) {
        const transactions = await invokeOperation(
          context,
          "payPerUseListTransactions",
          () =>
            context.sdk.payPerUseListTransactions({
              client: context.accountClient,
              query: { limit: 100, offset: 0 },
              signal: signal(),
            }),
          exactSuccess(200),
        );
        const startedAt = Date.parse(journal.payment.dispatchedAt);
        const matches =
          transactions.record.behavior === "success"
            ? resultRows<PayPerUseTransactionView>(transactions.result).filter(
                (candidate) =>
                  candidate.kind === "payment" &&
                  candidate.slug === journal.payment.slug &&
                  candidate.subAccount === journal.updatedLabel &&
                  Date.parse(candidate.createdAt) >= startedAt,
              )
            : [];
        if (matches.length === 1) {
          journal.payment.transactionId = matches[0]?.id;
          transaction = journal.payment.transactionId
            ? await pollOwnTransaction(context, journal.payment.transactionId)
            : undefined;
        }
      }
      if (transaction?.terminal) {
        const transactionState = classifyFinancialView(transaction);
        journal.payment.phase =
          transactionState === "succeeded" || transactionState === "failed"
            ? transactionState
            : "uncertain";
        journal.payment.charged = "unknown";
        context.charged = "unknown";
      }
      await writeJournal(journalPath, journal);
    }
    const keyRetired = await retireAgentKey(context, journalPath, journal);
    const subAccountRetired = paymentResolved(journal)
      ? await retireSubAccount(context, journalPath, journal)
      : false;
    journal.status =
      keyRetired && subAccountRetired ? "complete" : "unresolved";
    await writeJournal(journalPath, journal);
    context.journalStatus = journal.status;
  });
}

export function summarize(
  context: RunContext,
  runtime: Runtime,
  options: RunOptions,
): number {
  const failures = context.records.filter((record) =>
    ["behavior-failure", "contract-failure", "request-failure"].includes(
      record.behavior,
    ),
  );
  const counts = Object.fromEntries(
    [
      "blocked",
      "behavior-failure",
      "contract-failure",
      "expected-refusal",
      "request-failure",
      "success",
    ].map((behavior) => [
      behavior,
      context.records.filter((record) => record.behavior === behavior).length,
    ]),
  );
  console.log(
    JSON.stringify(
      {
        apiOrigin: context.apiOrigin,
        charged: context.charged,
        counts,
        entrySha256: runtime.entrySha256,
        invokedOperations: [...context.invoked].sort(),
        journalStatus: context.journalStatus,
        mode: options.reconcile
          ? "reconcile"
          : options.spend
            ? "mutations-and-spend"
            : options.mutations
              ? "mutations"
              : "read-only",
        openapiSha256: runtime.openapiSha256,
        openapiVersion: runtime.openapi.info?.version ?? null,
        packageName: runtime.packageName,
        sdkVersion: runtime.packageVersion,
        sdkTreeSha256: runtime.sdkTreeSha256,
      },
      null,
      2,
    ),
  );
  return failures.length === 0 && context.journalStatus !== "unresolved"
    ? 0
    : 1;
}

export async function main(
  arguments_ = process.argv.slice(2),
  environment = process.env,
  redactor = createSecretRedactor([
    environment.PERFLO_ACCOUNT_KEY,
    environment.PERFLO_LIVE_CONFIRMATION_CODE,
  ]),
): Promise<number> {
  const options = parseArguments(arguments_);
  if (options.help) {
    usage();
    return 0;
  }
  const journalPath = resolve(
    environment.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH,
  );
  if (options.unlock) {
    await unlockJournal(journalPath);
    return 0;
  }
  const accountKey = environment.PERFLO_ACCOUNT_KEY?.trim();
  if (!accountKey) throw new Error("PERFLO_ACCOUNT_KEY is required");
  const runtime = await loadRuntime(environment);
  const inventoryErrors = inventoryOperations(runtime.sdk, runtime.openapi);
  const responseValidator = await createOpenApiResponseValidator(
    runtime.openapiSource,
  );
  if (responseValidator.documentSha256 !== runtime.openapiSha256) {
    throw new Error(
      "OpenAPI validator digest does not match the loaded contract",
    );
  }
  const apiOrigin =
    environment.PERFLO_API_BASE_URL?.trim() || DEFAULT_API_ORIGIN;
  const maxCharge = parseMoney(environment.PERFLO_LIVE_MAX_CHARGE);
  const vendorSlug =
    environment.PERFLO_LIVE_VENDOR_SLUG?.trim() || DEFAULT_VENDOR_SLUG;
  const accountClient = runtime.sdk.createPerfloClient({
    baseUrl: apiOrigin,
    token: accountKey,
  });
  redactor.add(accountKey);
  redactor.add(environment.PERFLO_LIVE_CONFIRMATION_CODE?.trim());
  const context: RunContext = {
    accountClient,
    addSecret: redactor.add,
    apiOrigin,
    charged: null,
    invoked: new Set(),
    journalStatus: null,
    maxCharge,
    redact: redactor.redact,
    records: [],
    sdk: runtime.sdk,
    validateResponse: async (operation, result) => {
      const status = result.response?.status;
      if (status === undefined) return ["response status is absent"];
      const [method, path] = OPERATION_ROUTES[operation];
      return await responseValidator.validateResponse({
        contentType: result.response?.headers.get("content-type") ?? null,
        method,
        path,
        status,
        value: responsePayload(result),
      });
    },
    vendorSlug,
  };
  for (const error of inventoryErrors) {
    console.log(`FAIL SDK/contract inventory: ${error}`);
  }
  if (inventoryErrors.length > 0) return 1;
  if (options.reconcile) {
    await reconcileRun(context, runtime, environment);
    return Math.max(
      inventoryErrors.length > 0 ? 1 : 0,
      summarize(context, runtime, options),
    );
  }
  const preflight = await runPreflight(context);
  preflight.failures.push(...inventoryErrors);
  if (options.mutations) {
    await runMutationWorkflow(
      context,
      preflight,
      runtime,
      options,
      environment,
    );
  }
  return Math.max(
    inventoryErrors.length > 0 ? 1 : 0,
    summarize(context, runtime, options),
  );
}

export async function runWithRedactedErrors(
  task: () => Promise<number>,
  redactor: ReturnType<typeof createSecretRedactor>,
  writeError: (message: string) => void = console.error,
): Promise<number> {
  try {
    return await task();
  } catch (error) {
    writeError(
      redactor.redact(
        `FAIL pay-per-use live exercise: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const redactor = createSecretRedactor([
    process.env.PERFLO_ACCOUNT_KEY,
    process.env.PERFLO_LIVE_CONFIRMATION_CODE,
  ]);
  process.exitCode = await runWithRedactedErrors(
    () => main(process.argv.slice(2), process.env, redactor),
    redactor,
  );
}
