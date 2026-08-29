import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSecretRedactor,
  inventoryOperations,
  main,
  matchExpectedOutcome,
  mutationsAllowed,
  newJournal,
  OPERATION_ROUTES,
  parseArguments,
  readJournal,
  reconcileRun,
  runMutationWorkflow,
  runPayment,
  runWithRedactedErrors,
  summarize,
  unlockJournal,
  withJournalLock,
  writeJournal,
} from "../scripts/pay-per-use-live.js";

type HttpMethod =
  | "delete"
  | "get"
  | "head"
  | "options"
  | "patch"
  | "post"
  | "put"
  | "trace";

interface OpenApiFixture {
  paths: Record<
    string,
    Partial<
      Record<
        HttpMethod,
        { operationId?: string; responses: Record<string, unknown> }
      >
    >
  >;
}

const temporaryDirectories = new Set<string>();

function expectedOperationId(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function sdkFixture(): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(OPERATION_ROUTES).map((name) => [name, () => undefined]),
  );
}

function openApiFixture(): OpenApiFixture {
  const paths: OpenApiFixture["paths"] = {};
  for (const [name, [method, path]] of Object.entries(OPERATION_ROUTES)) {
    paths[path] ??= {};
    const pathItem = paths[path];
    pathItem[method] = {
      operationId: expectedOperationId(name),
      responses: {},
    };
  }
  return { paths };
}

function inventory(
  sdk: Record<string, unknown>,
  openapi: OpenApiFixture,
): Array<string> {
  return inventoryOperations(
    sdk as Parameters<typeof inventoryOperations>[0],
    openapi as Parameters<typeof inventoryOperations>[1],
  );
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "perflo-pay-per-use-live-"));
  temporaryDirectories.add(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryDirectories].map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
  temporaryDirectories.clear();
});

describe("parseArguments", () => {
  it("uses the read-only safe default", () => {
    expect(parseArguments([])).toEqual({
      help: false,
      mutations: false,
      preflight: false,
      reconcile: false,
      spend: false,
      unlock: false,
    });
  });

  it("recognizes help and ignores the option separator", () => {
    expect(parseArguments(["--", "--help"])).toEqual({
      help: true,
      mutations: false,
      preflight: false,
      reconcile: false,
      spend: false,
      unlock: false,
    });
  });

  it("rejects unknown options", () => {
    expect(() => parseArguments(["--unknown", "--also-unknown"])).toThrow(
      "unknown option: --unknown, --also-unknown",
    );
  });

  it("requires mutations before spend can be enabled", () => {
    expect(() => parseArguments(["--spend"])).toThrow(
      "--spend requires --mutations",
    );
    expect(parseArguments(["--mutations", "--spend"])).toMatchObject({
      mutations: true,
      spend: true,
    });
  });

  it("keeps explicit preflight separate from writes and recovery", () => {
    for (const option of [
      "--mutations",
      "--spend",
      "--reconcile",
      "--unlock",
    ]) {
      expect(() => parseArguments(["--preflight", option])).toThrow(
        "--preflight runs separately from mutation and recovery options",
      );
    }
  });

  it.each([
    ["reconcile and unlock", ["--reconcile", "--unlock"]],
    ["reconcile and mutations", ["--reconcile", "--mutations"]],
    ["unlock and mutations", ["--unlock", "--mutations"]],
  ])("keeps %s mutually exclusive", (_description, arguments_) => {
    expect(() => parseArguments(arguments_)).toThrow(
      "--reconcile and --unlock run separately from --mutations",
    );
  });
});

describe("inventoryOperations", () => {
  it("accepts an exact SDK export and OpenAPI route inventory", () => {
    expect(inventory(sdkFixture(), openApiFixture())).toEqual([]);
  });

  it("reports a missing SDK operation", () => {
    const sdk = sdkFixture();
    delete sdk.payPerUsePayVendor;

    expect(inventory(sdk, openApiFixture())).toContain(
      "missing SDK export payPerUsePayVendor",
    );
  });

  it("reports an unplanned SDK operation", () => {
    const sdk = sdkFixture();
    sdk.payPerUseUnexpectedOperation = () => undefined;

    expect(inventory(sdk, openApiFixture())).toContain(
      "unplanned SDK export payPerUseUnexpectedOperation",
    );
  });

  it("reports an SDK operation mapped to another pay-per-use route", () => {
    const openapi = openApiFixture();
    const accountRoute = openapi.paths["/v1/account"];
    if (!accountRoute) throw new Error("fixture has no account route");
    accountRoute.get = {
      operationId: "pay_per_use_get_vendor",
      responses: {},
    };

    expect(inventory(sdkFixture(), openapi)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/payPerUseGetAccount.*GET \/v1\/account/),
      ]),
    );
  });

  it("reports a pay-per-use OpenAPI operation omitted from the SDK and plan", () => {
    const openapi = openApiFixture();
    openapi.paths["/v1/new-operation"] = {
      get: {
        operationId: "pay_per_use_new_operation",
        responses: {},
      },
    };

    expect(inventory(sdkFixture(), openapi)).toContain(
      "unplanned OpenAPI operation pay_per_use_new_operation at GET /v1/new-operation",
    );
  });

  it("finds an unplanned pay-per-use operation on every HTTP method", () => {
    const openapi = openApiFixture();
    openapi.paths["/v1/new-put-operation"] = {
      put: {
        operationId: "pay_per_use_new_put_operation",
        responses: {},
      },
    };

    expect(inventory(sdkFixture(), openapi)).toContain(
      "unplanned OpenAPI operation pay_per_use_new_put_operation at PUT /v1/new-put-operation",
    );
  });
});

describe("safety helpers", () => {
  it("matches only an exact status and error-code pair", () => {
    const expected = [
      { behavior: "expected-refusal" as const, code: "FIRST", status: 401 },
      { behavior: "expected-refusal" as const, code: "SECOND", status: 403 },
    ];

    expect(matchExpectedOutcome(401, "FIRST", expected)).toEqual(expected[0]);
    expect(matchExpectedOutcome(403, "SECOND", expected)).toEqual(expected[1]);
    expect(matchExpectedOutcome(401, "SECOND", expected)).toBeUndefined();
    expect(matchExpectedOutcome(403, "FIRST", expected)).toBeUndefined();
  });

  it("requires an account identifier and a clean preflight before mutations", () => {
    const clean = {
      accountId: "account-1",
      agentKeys: [],
      failures: [],
      subAccounts: [],
    };

    expect(mutationsAllowed(clean)).toBe(true);
    expect(mutationsAllowed({ ...clean, accountId: undefined })).toBe(false);
    expect(mutationsAllowed({ ...clean, failures: ["contract drift"] })).toBe(
      false,
    );
  });

  it("redacts configured secrets and bearer credentials", () => {
    const redactor = createSecretRedactor(["account-secret"]);
    redactor.add("agent-secret");

    const value = redactor.redact(
      "account-secret agent-secret Authorization: Bearer another-secret",
    );

    expect(value).toBe(
      "[redacted] [redacted] Authorization: Bearer [redacted]",
    );
  });

  it("redacts a secret learned before an error escapes the command", async () => {
    const redactor = createSecretRedactor(["account-secret"]);
    const errors: Array<string> = [];

    await expect(
      runWithRedactedErrors(
        async () => {
          redactor.add("one-time-agent-secret");
          throw new Error("request echoed one-time-agent-secret");
        },
        redactor,
        (message) => errors.push(message),
      ),
    ).resolves.toBe(1);
    expect(errors).toEqual([
      "FAIL pay-per-use live exercise: request echoed [redacted]",
    ]);
  });

  it("returns failure while a journal remains unresolved", () => {
    const context = {
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: "unknown",
      invoked: new Set(),
      journalStatus: "unresolved",
      records: [],
    } as unknown as Parameters<typeof summarize>[0];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      summarize(
        context,
        {
          entrySha256: "a".repeat(64),
          openapi: { info: { version: "1.0.0" } },
          openapiSha256: "b".repeat(64),
          packageName: "@perflo/finance-sdk",
          packageVersion: "1.2.3",
          sdkTreeSha256: "c".repeat(64),
        } as Parameters<typeof summarize>[1],
        {} as Parameters<typeof summarize>[2],
      ),
    ).toBe(1);
  });
});

describe("mutation journal", () => {
  function journalFixture() {
    return newJournal(
      {
        accountId: "account-1",
        apiOrigin: "https://api-gateway.perflo.ai",
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        sdkVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      },
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      { amount: "0.01", currency: "USD" },
      "vendor-1",
    );
  }

  it("persists a valid journal atomically with owner-only permissions", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.json");
    const journal = journalFixture();

    await writeJournal(path, journal);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readJournal(path)).resolves.toEqual(journal);
    expect(await readFile(path, "utf8")).not.toContain("account-secret");
    expect(await readdir(directory)).toEqual(["journal.json"]);
  });

  it("rejects malformed journals", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.json");
    await writeFile(path, '{"version":2,"status":"complete"}\n');

    await expect(readJournal(path)).rejects.toThrow(
      `${path} has an invalid journal shape`,
    );
  });

  it("holds an owner-only exclusive lock and releases it after errors", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.json");
    const lockPath = `${path}.lock`;

    await expect(
      withJournalLock(path, async () => {
        expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        await expect(
          withJournalLock(path, async () => undefined),
        ).rejects.toThrow(`${lockPath} exists`);
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withJournalLock(path, async () => "released")).resolves.toBe(
      "released",
    );
  });

  it("refuses active and young locks, then removes a stale dead lock", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.json");
    const lockPath = `${path}.lock`;

    await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
    await expect(unlockJournal(path)).rejects.toThrow(
      `${lockPath} belongs to active process ${process.pid}`,
    );

    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }));
    await expect(unlockJournal(path)).rejects.toThrow(
      `${lockPath} is less than one minute old`,
    );

    const old = new Date(Date.now() - 61_000);
    await utimes(lockPath, old, old);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await unlockJournal(path);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("runMutationWorkflow", () => {
  it("dispatches no SDK operation and creates no journal after failed preflight", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const records: Array<Record<string, unknown>> = [];
    const sdk = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`unexpected SDK access: ${String(property)}`);
        },
      },
    );
    const context = {
      accountClient: {},
      addSecret: () => undefined,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      maxCharge: { amount: "0.01", currency: "USD" },
      records,
      redact: (value: string) => value,
      sdk,
      validateResponse: async () => [],
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof runMutationWorkflow>[0];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMutationWorkflow(
      context,
      {
        accountId: "account-1",
        agentKeys: [],
        failures: ["contract drift"],
        subAccounts: [],
      },
      {} as Parameters<typeof runMutationWorkflow>[2],
      {} as Parameters<typeof runMutationWorkflow>[3],
      { PERFLO_LIVE_JOURNAL: journalPath },
    );

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          behavior: "blocked",
          detail: "preflight failed; no mutation was dispatched",
          operation: "payPerUseCreateSubAccount",
        }),
        expect.objectContaining({
          behavior: "blocked",
          operation: "payPerUsePayVendor",
        }),
      ]),
    );
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${journalPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("completes the journal after a definitive sub-account create refusal", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const records: Array<Record<string, unknown>> = [];
    const sdk = {
      createPerfloClient: (options: unknown) => options,
      payPerUseCreateAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseRevokeAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseCreateSubAccount: () => ({
        error: { error: { code: "VALIDATION_ERROR" } },
        response: new Response(null, { status: 422 }),
      }),
      payPerUseListAgentKeys: () => ({
        data: { data: [] },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseListSubAccounts: () => ({
        data: { data: [] },
        response: new Response(null, { status: 200 }),
      }),
    };
    const context = {
      accountClient: {},
      addSecret: () => undefined,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      journalStatus: null,
      maxCharge: { amount: "0.01", currency: "USD" },
      records,
      redact: (value: string) => value,
      sdk,
      validateResponse: async () => [],
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof runMutationWorkflow>[0];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMutationWorkflow(
      context,
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      {
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        packageVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      } as Parameters<typeof runMutationWorkflow>[2],
      { spend: false } as Parameters<typeof runMutationWorkflow>[3],
      { PERFLO_LIVE_JOURNAL: journalPath },
    );

    await expect(readJournal(journalPath)).resolves.toMatchObject({
      status: "complete",
      subAccount: { phase: "absent" },
    });
    expect(
      (context as unknown as { journalStatus: string }).journalStatus,
    ).toBe("complete");
  });

  it("cleans up created resources after a redacted post-create failure", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const redactor = createSecretRedactor([]);
    const addSecret = vi.fn(redactor.add);
    const records: Array<Record<string, unknown>> = [];
    let agentRevoked = false;
    let subAccountDisabled = false;
    const revokeAgentKey = vi.fn(() => {
      agentRevoked = true;
      return {
        data: { data: {} },
        response: new Response(null, { status: 200 }),
      };
    });
    const disableSubAccount = vi.fn(() => {
      subAccountDisabled = true;
      return {
        data: { data: {} },
        response: new Response(null, { status: 200 }),
      };
    });
    const sdk = {
      createPerfloClient: (options: unknown) => options,
      payPerUseCreateAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseRevokeAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseCreateSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 201 }),
      }),
      payPerUseGetSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseUpdateSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseCreateAgentKey: () => ({
        data: { data: { id: "agent-key-1", key: "agent-secret" } },
        response: new Response(null, { status: 201 }),
      }),
      payPerUseGetCallerAgentKey: () => {
        throw new Error("transport echoed agent-secret");
      },
      payPerUseRejectBulkSubAccountDeletion: () => ({
        error: { code: "METHOD_NOT_ALLOWED" },
        response: new Response(null, { status: 405 }),
      }),
      payPerUseRevokeAgentKey: revokeAgentKey,
      payPerUseListAgentKeys: () => ({
        data: {
          data: [
            {
              id: "agent-key-1",
              revokedAt: agentRevoked ? "2026-08-29T00:00:00.000Z" : null,
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseDisableSubAccount: disableSubAccount,
      payPerUseListSubAccounts: () => ({
        data: {
          data: [
            {
              id: "sub-account-1",
              status: subAccountDisabled ? "disabled" : "active",
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      }),
    };
    const context = {
      accountClient: {},
      addSecret,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      maxCharge: { amount: "0.01", currency: "USD" },
      records,
      redact: redactor.redact,
      sdk,
      validateResponse: async () => [],
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof runMutationWorkflow>[0];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMutationWorkflow(
      context,
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      {
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        packageVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      } as Parameters<typeof runMutationWorkflow>[2],
      { spend: false } as Parameters<typeof runMutationWorkflow>[3],
      { PERFLO_LIVE_JOURNAL: journalPath },
    );

    expect(revokeAgentKey).toHaveBeenCalledOnce();
    expect(disableSubAccount).toHaveBeenCalledOnce();
    expect(addSecret).toHaveBeenCalledWith("agent-secret");
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          behavior: "request-failure",
          detail: "transport echoed [redacted]",
          operation: "payPerUseGetCallerAgentKey",
        }),
      ]),
    );
    await expect(readJournal(journalPath)).resolves.toMatchObject({
      agentKey: { id: "agent-key-1", phase: "retired" },
      status: "complete",
      subAccount: { id: "sub-account-1", phase: "retired" },
    });
    expect(await readFile(journalPath, "utf8")).not.toContain("agent-secret");
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(
      "agent-secret",
    );
  });

  it("revokes the agent key but preserves the sub-account for an unknown payment", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const redactor = createSecretRedactor([]);
    let agentRevoked = false;
    const disableSubAccount = vi.fn();
    const sdk = {
      createPerfloClient: (options: unknown) => options,
      payPerUseCreateAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseRevokeAccountKey: () => ({
        error: { code: "UNAUTHENTICATED" },
        response: new Response(null, { status: 401 }),
      }),
      payPerUseCreateSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 201 }),
      }),
      payPerUseGetSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseUpdateSubAccount: () => ({
        data: { data: { id: "sub-account-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseCreateAgentKey: () => ({
        data: { data: { id: "agent-key-1", key: "agent-secret" } },
        response: new Response(null, { status: 201 }),
      }),
      payPerUseGetCallerAgentKey: () => ({
        data: { data: { id: "agent-key-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseRejectBulkSubAccountDeletion: () => ({
        error: { code: "METHOD_NOT_ALLOWED" },
        response: new Response(null, { status: 405 }),
      }),
      payVendorSafely: async () => ({
        data: {
          idempotencyKey: "payment-key",
          kind: "unknown",
          lastError: new Error("lost response"),
        },
        error: undefined,
      }),
      payPerUseListAgentKeys: () => ({
        data: {
          data: [
            {
              id: "agent-key-1",
              revokedAt: agentRevoked ? "2026-08-29T00:00:00.000Z" : null,
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseRevokeAgentKey: () => {
        agentRevoked = true;
        return {
          data: { data: {} },
          response: new Response(null, { status: 200 }),
        };
      },
      payPerUseListSubAccounts: () => ({
        data: { data: [{ id: "sub-account-1", status: "active" }] },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseDisableSubAccount: disableSubAccount,
    };
    const context = {
      accountClient: {},
      addSecret: redactor.add,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      journalStatus: null,
      maxCharge: { amount: "0.01", currency: "USD" },
      records: [],
      redact: redactor.redact,
      sdk,
      validateResponse: async () => [],
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof runMutationWorkflow>[0];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMutationWorkflow(
      context,
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      {
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        packageVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      } as Parameters<typeof runMutationWorkflow>[2],
      { spend: true } as Parameters<typeof runMutationWorkflow>[3],
      { PERFLO_LIVE_JOURNAL: journalPath },
    );

    expect(agentRevoked).toBe(true);
    expect(disableSubAccount).not.toHaveBeenCalled();
    expect(
      (context as unknown as { journalStatus: string }).journalStatus,
    ).toBe("unresolved");
    await expect(readJournal(journalPath)).resolves.toMatchObject({
      agentKey: { phase: "retired" },
      payment: { charged: "unknown", phase: "uncertain" },
      status: "unresolved",
      subAccount: { phase: "active" },
    });
  });
});

describe("runPayment", () => {
  function paymentJournal() {
    return newJournal(
      {
        accountId: "account-1",
        apiOrigin: "https://api-gateway.perflo.ai",
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        sdkVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      },
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      { amount: "0.01", currency: "USD" },
      "vendor-1",
    );
  }

  function paymentContext(
    sdk: Record<string, unknown>,
    validateResponse: () => Promise<Array<string>> = async () => [],
  ) {
    return {
      accountClient: {},
      addSecret: () => undefined,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      journalStatus: null,
      maxCharge: { amount: "0.01", currency: "USD" },
      records: [],
      redact: (value: string) => value,
      sdk,
      validateResponse,
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof runPayment>[0];
  }

  function transaction() {
    return {
      chargeIsFinal: true,
      id: "transaction-1",
      status: "succeeded",
      terminal: true,
    };
  }

  function payment() {
    return {
      chargeIsFinal: true,
      charged: { amount: "0.01", currency: "USD" },
      status: "succeeded",
      terminal: true,
      transactionId: "transaction-1",
    };
  }

  it("records an exact terminal charge after a settled payment", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: payment(), meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "settled",
        },
        error: undefined,
        response: new Response("{}", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      }),
      payPerUseGetTransaction: async () => ({
        data: { data: transaction(), meta: { requestId: "request-2" } },
        response: new Response("{}", { status: 200 }),
      }),
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({
      charged: { amount: "0.01", currency: "USD" },
      phase: "succeeded",
      transactionId: "transaction-1",
    });
    expect((context as unknown as { charged: unknown }).charged).toEqual({
      amount: "0.01",
      currency: "USD",
    });
  });

  it("preserves a conclusive terminal success when its verification read fails", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: payment(), meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "settled",
        },
        error: undefined,
        response: new Response("{}", { status: 200 }),
      }),
      payPerUseGetTransaction: async () => {
        throw new Error("temporary transaction read failure");
      },
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({
      charged: { amount: "0.01", currency: "USD" },
      phase: "succeeded",
    });
    expect(
      (
        context as unknown as {
          records: Array<Record<string, unknown>>;
        }
      ).records,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          behavior: "request-failure",
          operation: "payPerUseGetTransaction",
        }),
        expect.objectContaining({
          behavior: "success",
          operation: "payPerUsePayVendor",
        }),
      ]),
    );
  });

  it("treats exhausted retry-safe 503 responses as undelivered and uncharged", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: undefined,
        error: {
          error: { code: "SERVICE_UNAVAILABLE", details: { retrySafe: true } },
        },
        response: new Response("{}", { status: 503 }),
      }),
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({ charged: null, phase: "failed" });
    expect((context as unknown as { charged: unknown }).charged).toBeNull();
  });

  it("keeps a contract-invalid payment refusal financially uncertain", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: undefined,
        error: { error: { code: "DUPLICATE_PAYMENT_IN_FLIGHT" } },
        response: new Response("{}", { status: 409 }),
      }),
    };
    const context = paymentContext(sdk, async () => ["schema mismatch"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "uncertain",
    });
  });

  it("validates a recovered transaction without attributing its GET status to pay", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "recovered",
          transaction: transaction(),
        },
        error: undefined,
        response: new Response("{}", { status: 200 }),
      }),
      payPerUseGetTransaction: async () => ({
        data: { data: transaction(), meta: { requestId: "request-2" } },
        response: new Response("{}", { status: 200 }),
      }),
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    const payRecord = (
      context as unknown as { records: Array<Record<string, unknown>> }
    ).records.find((record) => record.operation === "payPerUsePayVendor");
    expect(payRecord).toMatchObject({ behavior: "success", status: null });
    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "succeeded",
    });
  });

  it("keeps an unknown payment unresolved with unknown spend", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "unknown",
          lastError: new Error("lost response"),
        },
        error: undefined,
      }),
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "uncertain",
    });
    expect((context as unknown as { charged: unknown }).charged).toBe(
      "unknown",
    );
  });

  it("does not confirm a held payment whose response fails its contract", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const confirm = vi.fn();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: payment(), meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "confirmation_required",
        },
        error: undefined,
        response: new Response("{}", {
          headers: { "Content-Type": "application/json" },
          status: 202,
        }),
      }),
      payPerUseConfirmPayment: confirm,
    };
    const context = paymentContext(sdk, async () => ["schema mismatch"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, "123456");

    expect(confirm).not.toHaveBeenCalled();
    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "uncertain",
    });
  });

  it("keeps a contract-invalid settled response uncertain without a valid transaction", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: payment(), meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "settled",
        },
        error: undefined,
        response: new Response("{}", { status: 200 }),
      }),
      payPerUseGetTransaction: async () => {
        throw new Error("transaction unavailable");
      },
    };
    const context = paymentContext(sdk, async () => ["schema mismatch"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, undefined);

    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "uncertain",
    });
    expect((context as unknown as { charged: unknown }).charged).toBe(
      "unknown",
    );
  });

  it("lets a terminal transaction complete a contract-valid open confirmation", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const pending = {
      chargeIsFinal: false,
      status: "pending_confirmation",
      terminal: false,
      transactionId: "transaction-1",
    };
    const queued = {
      chargeIsFinal: false,
      status: "queued",
      terminal: false,
      transactionId: "transaction-1",
    };
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: pending, meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "confirmation_required",
        },
        error: undefined,
        response: new Response("{}", { status: 202 }),
      }),
      payPerUseConfirmPayment: async () => ({
        data: { data: queued, meta: { requestId: "request-2" } },
        response: new Response("{}", { status: 200 }),
      }),
      payPerUseGetTransaction: async () => ({
        data: { data: transaction(), meta: { requestId: "request-3" } },
        response: new Response("{}", { status: 200 }),
      }),
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, "123456");

    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "succeeded",
      transactionId: "transaction-1",
    });
  });

  it("keeps an open confirmation unresolved when no terminal transaction is readable", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = paymentJournal();
    const pending = {
      chargeIsFinal: false,
      status: "pending_confirmation",
      terminal: false,
      transactionId: "transaction-1",
    };
    const sdk = {
      payVendorSafely: async () => ({
        data: {
          data: { data: pending, meta: { requestId: "request-1" } },
          idempotencyKey: journal.payment.idempotencyKey,
          kind: "confirmation_required",
        },
        error: undefined,
        response: new Response("{}", { status: 202 }),
      }),
      payPerUseConfirmPayment: async () => ({
        data: {
          data: { ...pending, status: "running" },
          meta: { requestId: "request-2" },
        },
        response: new Response("{}", { status: 200 }),
      }),
      payPerUseGetTransaction: async () => {
        throw new Error("temporary transaction read failure");
      },
    };
    const context = paymentContext(sdk);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runPayment(context, journalPath, journal, {} as never, "123456");

    expect(journal.payment).toMatchObject({
      charged: "unknown",
      phase: "uncertain",
      transactionId: "transaction-1",
    });
  });
});

describe("reconcileRun", () => {
  it("uses a journaled transaction ID and verifies cleanup without scanning history", async () => {
    const directory = await makeTemporaryDirectory();
    const journalPath = join(directory, "journal.json");
    const journal = newJournal(
      {
        accountId: "account-1",
        apiOrigin: "https://api-gateway.perflo.ai",
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        sdkVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      },
      {
        accountId: "account-1",
        agentKeys: [],
        failures: [],
        subAccounts: [],
      },
      { amount: "0.01", currency: "USD" },
      "vendor-1",
    );
    journal.agentKey = { id: "agent-key-1", phase: "active" };
    journal.subAccount = { id: "sub-account-1", phase: "active" };
    journal.payment.phase = "uncertain";
    journal.payment.dispatchedAt = "2026-08-29T00:00:00.000Z";
    journal.payment.transactionId = "transaction-1";
    journal.status = "unresolved";
    await writeJournal(journalPath, journal);

    let keyRevoked = false;
    let subAccountDisabled = false;
    const listTransactions = vi.fn(() => {
      throw new Error("history scan must not run");
    });
    const sdk = {
      payPerUseGetAccount: () => ({
        data: { data: { accountId: "account-1" } },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseGetTransaction: () => ({
        data: {
          data: {
            chargeIsFinal: true,
            id: "transaction-1",
            status: "succeeded",
            terminal: true,
          },
        },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseListTransactions: listTransactions,
      payPerUseListAgentKeys: () => ({
        data: {
          data: [
            {
              id: "agent-key-1",
              revokedAt: keyRevoked ? "2026-08-29T00:01:00.000Z" : null,
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseRevokeAgentKey: () => {
        keyRevoked = true;
        return {
          data: { data: {} },
          response: new Response(null, { status: 200 }),
        };
      },
      payPerUseListSubAccounts: () => ({
        data: {
          data: [
            {
              id: "sub-account-1",
              status: subAccountDisabled ? "disabled" : "active",
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      }),
      payPerUseDisableSubAccount: () => {
        subAccountDisabled = true;
        return {
          data: { data: {} },
          response: new Response(null, { status: 200 }),
        };
      },
    };
    const context = {
      accountClient: {},
      addSecret: () => undefined,
      apiOrigin: "https://api-gateway.perflo.ai",
      charged: null,
      invoked: new Set(),
      journalStatus: null,
      maxCharge: { amount: "0.01", currency: "USD" },
      records: [],
      redact: (value: string) => value,
      sdk,
      validateResponse: async () => [],
      vendorSlug: "vendor-1",
    } as unknown as Parameters<typeof reconcileRun>[0];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await reconcileRun(
      context,
      {
        entrySha256: "d".repeat(64),
        openapiSha256: "a".repeat(64),
        packageVersion: "1.2.3",
        sdkTreeSha256: "b".repeat(64),
      } as Parameters<typeof reconcileRun>[1],
      { PERFLO_LIVE_JOURNAL: journalPath },
    );

    expect(listTransactions).not.toHaveBeenCalled();
    await expect(readJournal(journalPath)).resolves.toMatchObject({
      agentKey: { phase: "retired" },
      payment: { phase: "succeeded", transactionId: "transaction-1" },
      status: "complete",
      subAccount: { phase: "retired" },
    });
    expect(
      (context as unknown as { journalStatus: string }).journalStatus,
    ).toBe("complete");
  });
});

describe("main", () => {
  it("prints help without requiring credentials or loading artifacts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["--help"], {})).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Safe default: run the read-only contract preflight.",
      ),
    );
  });

  it("rejects an SDK artifact version mismatch before making requests", async () => {
    const directory = await makeTemporaryDirectory();
    const dist = join(directory, "dist");
    await mkdir(dist);
    const sdkEntry = join(dist, "sdk.mjs");
    const packageJson = join(directory, "package.json");
    const openapi = join(directory, "openapi.json");
    await Promise.all([
      writeFile(sdkEntry, "export const fixture = true;\n"),
      writeFile(
        packageJson,
        '{"name":"@perflo/finance-sdk","version":"1.2.3"}\n',
      ),
      writeFile(openapi, '{"paths":{}}\n'),
    ]);

    await expect(
      main([], {
        PERFLO_ACCOUNT_KEY: "account-key-must-not-appear",
        PERFLO_EXPECTED_SDK_VERSION: "9.9.9",
        PERFLO_OPENAPI_PATH: openapi,
        PERFLO_SDK_ENTRY: sdkEntry,
        PERFLO_SDK_PACKAGE_JSON: packageJson,
      }),
    ).rejects.toThrow("SDK artifact is 1.2.3, expected 9.9.9");
  });

  it("rejects an SDK entry outside the selected package dist tree", async () => {
    const directory = await makeTemporaryDirectory();
    const selected = join(directory, "selected");
    const dist = join(selected, "dist");
    const external = join(directory, "external.mjs");
    const packageJson = join(selected, "package.json");
    const openapi = join(directory, "openapi.json");
    await mkdir(dist, { recursive: true });
    await Promise.all([
      writeFile(join(dist, "index.js"), "export const selected = true;\n"),
      writeFile(external, "export const external = true;\n"),
      writeFile(
        packageJson,
        '{"name":"@perflo/finance-sdk","version":"1.2.3"}\n',
      ),
      writeFile(openapi, '{"paths":{}}\n'),
    ]);

    await expect(
      main([], {
        PERFLO_ACCOUNT_KEY: "account-key-must-not-appear",
        PERFLO_OPENAPI_PATH: openapi,
        PERFLO_SDK_ENTRY: external,
        PERFLO_SDK_PACKAGE_JSON: packageJson,
      }),
    ).rejects.toThrow(
      "PERFLO_SDK_ENTRY must belong to the selected package dist tree",
    );
  });

  it("treats unlocking a missing journal lock as an idempotent cleanup", async () => {
    const directory = await makeTemporaryDirectory();
    const journal = join(directory, "journal.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main(["--unlock"], { PERFLO_LIVE_JOURNAL: journal }),
    ).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(`PASS ${journal}.lock does not exist`);
  });
});
