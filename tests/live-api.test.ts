import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindSubmittedOperation,
  boundedDelay,
  check,
  checkAuthorizedDevices,
  createJournalEntry,
  describeError,
  dispatchAfterJournal,
  ensurePerfloConnection,
  followOperation,
  type Journal,
  type JournalContext,
  loadJournal,
  mutationPath,
  parseCardActionScenario,
  parseObjectEnvJson,
  readLiveConfig,
  reconcileJournal,
  requireAccounts,
  requireCardRevealAction,
  requireDeviceList,
  requireDevicePrincipalMatch,
  requireDisplayCurrency,
  requireExpectedId,
  requireKyc,
  requireKycAction,
  requireMandates,
  requireMatchingOperation,
  requireOnboardingData,
  requireOperationsArray,
  requirePublicConfig,
  requirePurchaseQuote,
  requireSafeApiBaseUrl,
  requireSpendingAccount,
  requireTransferQuote,
  runJournaledMutation,
  runWebhook,
  unlockJournal,
  withJournalLock,
} from "../scripts/live-api.js";
import {
  createBeneficiary,
  createCard,
  createMandate,
  createPerfloClient,
  createPurchase,
  createSpendingWithdrawal,
  createTransfer,
  executeMandate,
  freezeCard,
  spendBeneficiaryGrant,
  unfreezeCard,
} from "../src/index.js";
import verificationUrlCorpus from "../verification-url-corpus.json" with {
  type: "json",
};

const execFileAsync = promisify(execFile);
const changedEnvironment = new Map<string, string | undefined>();

function operationFixture(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    approval_resolvable: false,
    authority_expires_at: null,
    created_at: "2026-08-14T10:00:01.000Z",
    failure_code: null,
    failure_detail: null,
    id: "operation-1",
    kind: "transfer",
    next_reconcile_at: null,
    resource_id: null,
    resource_type: null,
    state: "submitted",
    submission_uncertain: false,
    updated_at: "2026-08-14T10:00:01.000Z",
    external_reference: null,
    ...overrides,
  };
}

function capabilitiesFixture(value = false): Record<string, boolean> {
  return Object.fromEntries(
    [
      "account_provisioning",
      "accounts",
      "activity",
      "asset_registry",
      "beneficiaries",
      "beneficiary_create",
      "card_create",
      "card_lifecycle",
      "card_reveal",
      "card_transactions",
      "cards",
      "display_preferences",
      "kyc_session",
      "kyc_status",
      "mandates",
      "purchases",
      "quotes",
      "recipient_metadata",
      "service_catalogue",
      "service_mandates",
      "service_quotes",
      "spending_account",
      "spending_withdrawals",
      "transfers",
    ].map((field) => [field, value]),
  );
}

function setEnvironment(name: string, value: string): void {
  if (!changedEnvironment.has(name)) {
    changedEnvironment.set(name, process.env[name]);
  }
  process.env[name] = value;
}

function abortAwareSend(
  observe?: (signal: AbortSignal) => void,
): (dispatch: { signal: AbortSignal }) => Promise<{ error: unknown }> {
  // The signal can arrive already aborted, and a listener attached to one never fires:
  // runJournaledMutation starts the submission clock before the journal write, and that
  // write costs two fsyncs, so a contended disk can spend the whole budget before the
  // signal is built. Listening without this guard leaves the promise unsettled forever
  // -- which is what made "bounds a financial dispatch" time out on CI while every
  // sibling finished in milliseconds. Real fetch already rejects on a pre-aborted
  // signal; only a hand-written double has to say so.
  return async ({ signal }) => {
    observe?.(signal);
    if (signal.aborted) {
      return { error: signal.reason };
    }
    return await new Promise((resolveResult) => {
      signal.addEventListener(
        "abort",
        () => resolveResult({ error: signal.reason }),
        {
          once: true,
        },
      );
    });
  };
}

afterEach(() => {
  for (const [name, value] of changedEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  changedEnvironment.clear();
  vi.restoreAllMocks();
});

describe("live API exercise safety", () => {
  it("includes a server request ID in formatted problem details", () => {
    expect(
      describeError(
        {
          code: "provider_unavailable",
          detail: "provider call failed",
          request_id: "request-123",
        },
        new Response(null, { status: 503 }),
      ),
    ).toBe(
      "503 provider_unavailable request_id=request-123 provider call failed",
    );
  });

  it("rejects unsupported card actions and array request bodies", () => {
    setEnvironment(
      "PERFLO_LIVE_CARD_ACTION",
      '{"action":"close","card_id":"card-1"}',
    );
    expect(() => parseCardActionScenario()).toThrow(/freeze.*unfreeze/);

    setEnvironment("PERFLO_LIVE_PURCHASE", "[]");
    expect(() => parseObjectEnvJson("PERFLO_LIVE_PURCHASE")).toThrow(
      /not an array/,
    );

    setEnvironment(
      "PERFLO_LIVE_MANDATE_EXECUTION",
      '{"mandate_id":"mandate-1","body":[]}',
    );
    setEnvironment(
      "PERFLO_LIVE_CARD_ACTION",
      '{"action":"freeze","card_id":"card-1"}',
    );
    expect(() => readLiveConfig(new Set(["--mutations"]))).toThrow(
      /object body/,
    );
  });

  it("caps waits at their remaining deadline", () => {
    expect(boundedDelay(60_000, 10_001, 10_000)).toBe(1);
    expect(boundedDelay(500, 9_999, 10_000)).toBe(0);
  });

  it("rejects timeout values that overflow Node timers", () => {
    setEnvironment("PERFLO_LIVE_OPERATION_TIMEOUT_MS", "2147483648");
    expect(() => readLiveConfig(new Set())).toThrow(/1 to 2147483647/);
  });

  it("rejects wrong-shape list and device 2xx bodies", async () => {
    const success = new Response("{}", { status: 200 });
    await expect(
      check(
        "list fixture",
        async () => ({ data: {}, response: success }),
        requireAccounts,
      ),
    ).resolves.toBeUndefined();
    await expect(
      check(
        "list 204 fixture",
        async () => ({
          data: undefined,
          response: new Response(null, { status: 204 }),
        }),
        requireAccounts,
      ),
    ).resolves.toBeUndefined();
    await expect(
      check(
        "device fixture",
        async () => ({ data: { success: true }, response: success }),
        requireDeviceList,
      ),
    ).resolves.toBeUndefined();
    await expect(
      check(
        "public fixture",
        async () => ({ data: {}, response: success }),
        requirePublicConfig,
      ),
    ).resolves.toBeUndefined();
    expect(
      requireOnboardingData({
        capabilities: {},
        customer: {
          created_at: "2026-08-14T09:00:00.000Z",
          email: "owner@example.com",
          id: "customer-1",
          locale: "en",
          status: "active",
        },
        perflo_connection: "connected",
      }),
    ).toMatch(/no usable onboarding/);
    expect(
      requireOnboardingData({
        capabilities: capabilitiesFixture(),
        customer: {
          created_at: "2026-08-14T09:00:00.000Z",
          email: "owner@example.com",
          id: "customer-1",
          locale: "en",
          status: "active",
        },
        kyc_session_available: true,
        perflo_account_identifier: 42,
        perflo_connection: "connected",
      }),
    ).toMatch(/no usable onboarding/);
  });

  it("rejects minimally present but unusable domain responses", () => {
    const money = { amount: "0.00", currency: "USD" };
    expect(requireAccounts([{ id: "account-1" }])).toMatch(/no usable/);
    expect(
      requireKyc({
        observed_at: "2026-08-14T10:00:00.000Z",
        status: "invented",
      }),
    ).toMatch(/no usable/);
    expect(
      requireDisplayCurrency({
        base_currency: "USD",
        currency: "AED",
        observed_at: "2026-08-14T10:00:00.000Z",
      }),
    ).toMatch(/no usable/);
    expect(
      requireSpendingAccount({ held: {}, owed: {}, promotional_credit: {} }),
    ).toMatch(/no usable/);
    expect(
      requirePurchaseQuote({
        confirm_by: "2026-08-14T10:05:00.000Z",
        id: "quote-1",
      }),
    ).toMatch(/no usable/);
    expect(
      requireTransferQuote({
        confirm_by: "2026-08-14T10:05:00.000Z",
        id: "quote-1",
      }),
    ).toMatch(/no usable/);
    expect(
      requireExpectedId(
        "account",
        "account-1",
        () => true,
      )({
        id: "account-2",
      }),
    ).toMatch(/does not match/);
    expect(requireOperationsArray([{ kind: "transfer" }])).toMatch(
      /no usable operation array/,
    );
    expect(
      requireMandates([
        {
          allowed_capabilities: null,
          allowed_services: null,
          authorized_clients: [
            {
              display_name: "fixture agent",
              id: "pairing-1",
              revoked_at: null,
              verified: true,
            },
          ],
          authorized_rules: [],
          beneficiary_id: null,
          created_at: "2026-08-14T10:00:00.000Z",
          daily_max: money,
          destination_currency: null,
          expires_at: "2026-08-15T10:00:00.000Z",
          id: "mandate-1",
          kind: "service_purchase",
          monthly_max: money,
          payment_count: 0,
          per_payment_max: money,
          purpose_code: null,
          remaining_daily_max: null,
          remaining_monthly_max: null,
          remaining_payment_count: null,
          remaining_total_cap: null,
          remaining_weekly_max: null,
          state: "active",
          total_cap: money,
          weekly_max: money,
        },
      ]),
    ).toMatch(/no usable mandate array/);
    expect(
      requireKycAction({
        expires_at: null,
        kind: "kyc_session",
        poll_after_ms: null,
        url: "https://127.1/kyc",
      }),
    ).toMatch(/allowed URL policy/);
    expect(
      requireKycAction({
        expires_at: "2020-01-01T00:00:00.000Z",
        kind: "kyc_session",
        poll_after_ms: null,
        url: "https://app.perflo.ai/kyc/fixture",
      }),
    ).toMatch(/expired/);
    expect(
      requireKycAction({
        expires_at: "not-a-date",
        kind: "kyc_session",
        poll_after_ms: null,
        url: "https://app.perflo.ai/kyc/fixture",
      }),
    ).toMatch(/expired/);
    expect(
      requireKycAction({
        expires_at: null,
        kind: "kyc_session",
        poll_after_ms: null,
        url: "https://verify.identity.example/kyc/fixture",
      }),
    ).toBeUndefined();
    expect(
      requireCardRevealAction({
        expires_at: "2020-01-01T00:00:00.000Z",
        kind: "card_reveal",
        poll_after_ms: null,
        url: "https://app.perflo.ai/cards/fixture",
      }),
    ).toMatch(/expired/);
  });

  // One corpus for the API boundary, the SDK export and the browser copy, and
  // this suite proves the exercise applies it. Adding a case to a single suite
  // is what let three separate divergences reach review.
  //
  // One case each way rather than the whole corpus: verification-url.test.ts runs
  // every case through the same function this exercise calls, so what is left to
  // prove here is that the exercise consults the rule at all. The first entry of
  // each list is that representative, so keep `reject[0]` a plainly shaped URL:
  // the exercise checks the action's shape before it reaches the policy, and a
  // first reject that is empty or not URL-shaped would fail here as a missing
  // action rather than as a refused one. Every accept entry is an HTTPS URL by
  // construction, so `reject[0]` is the only entry that can break this suite.
  const kycAction = (url: string) =>
    requireKycAction({
      expires_at: null,
      kind: "kyc_session",
      poll_after_ms: null,
      url,
    });

  it.each(
    verificationUrlCorpus.accept.slice(0, 1),
  )("accepts a KYC URL inside the allowed policy: %s", (url) => {
    expect(kycAction(url)).toBeUndefined();
  });

  it.each(
    verificationUrlCorpus.reject.slice(0, 1),
  )("rejects a KYC URL outside the allowed policy: %s", (url) => {
    expect(kycAction(url)).toMatch(/allowed URL policy/);
  });

  it("does not accept a transfer quote for a different request", async () => {
    const requested = {
      beneficiary_id: "beneficiary-1",
      source: { amount: "10.00", currency: "USD" },
    };
    const quoted = {
      beneficiary_id: "beneficiary-2",
      confirm_by: new Date(Date.now() + 60_000).toISOString(),
      estimated_at: new Date().toISOString(),
      estimated_destination: { amount: "36.50", currency: "AED" },
      estimated_fee: { amount: "0.50", currency: "AED" },
      estimated_payout_rate: "3.70",
      executable: false,
      id: "quote-1",
      local_units_per_usd: "3.70",
      perflo_cash_debit: { amount: "10.00", currency: "USD" },
      requested_source: { amount: "11.00", currency: "USD" },
    };
    const dispatch = vi.fn();
    const accepted = await check(
      "crossed quote fixture",
      async () => ({
        data: quoted,
        response: new Response(JSON.stringify(quoted), { status: 201 }),
      }),
      (data) => requireTransferQuote(data, requested),
    );
    if (accepted) {
      dispatch();
    }
    expect(accepted).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("binds device metadata to authenticated customer reads", () => {
    const state = {
      customer: { email: "owner@example.com" },
    } as never;
    expect(() =>
      requireDevicePrincipalMatch(
        {
          email: "other@example.com",
          token: "token",
          wallet: "0xabc",
        },
        state,
        { wallet: "0xabc" },
      ),
    ).toThrow(/email does not match/);
    expect(() =>
      requireDevicePrincipalMatch(
        {
          email: "owner@example.com",
          token: "token",
          wallet: "0xdef",
        },
        state,
        { wallet: "0xabc" },
      ),
    ).toThrow(/wallet does not match/);
    expect(() =>
      requireDevicePrincipalMatch(
        {
          email: "owner@example.com",
          token: "token",
          wallet: "0xabc",
        },
        { customer: { email: null } } as never,
        { wallet: "0xabc" },
      ),
    ).not.toThrow();
  });

  it("skips the known slow authorized-device response on 504 only", async () => {
    const logs: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...values) => {
      logs.push(values.join(" "));
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            code: "gateway_timeout",
            detail: "The upstream device list timed out.",
            status: 504,
          }),
          {
            headers: { "Content-Type": "application/problem+json" },
            status: 504,
          },
        )) as typeof globalThis.fetch,
      token: "customer-token",
    });

    await checkAuthorizedDevices(client);

    expect(logs.join("\n")).toContain(
      "SKIP authorized devices: 504 from slow upstream device list",
    );

    const failingClient = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            code: "service_unavailable",
            detail: "The upstream device service is unavailable.",
            status: 503,
          }),
          {
            headers: { "Content-Type": "application/problem+json" },
            status: 503,
          },
        )) as typeof globalThis.fetch,
      token: "customer-token",
    });

    await checkAuthorizedDevices(failingClient);

    expect(logs.join("\n")).toContain("FAIL authorized devices: 503");
  });

  it("persists the exact request and rejects mismatched operation evidence", () => {
    const body = { amount: "10.00" };
    const confirmation = { beneficiary_id: "beneficiary-1", ...body };
    const entry = createJournalEntry(
      "beneficiary_grant.spend",
      mutationPath("beneficiary_grant.spend", "grant-1"),
      body,
      confirmation,
    );
    entry.submission_started_at = "2026-08-14T10:00:00.000Z";

    expect(entry).toMatchObject({
      body,
      confirmation_payload: confirmation,
      method: "POST",
      path: "/v1/mandates/beneficiary-grants/grant-1/payments",
    });
    expect(() =>
      requireMatchingOperation(
        entry,
        operationFixture({ kind: "transfer", state: "succeeded" }) as never,
      ),
    ).toThrow(/does not match/);
    expect(() =>
      requireMatchingOperation(
        entry,
        operationFixture({
          created_at: "2026-08-14T09:54:00.000Z",
          kind: "beneficiary_grant_payment",
          state: "succeeded",
          updated_at: "2026-08-14T09:54:00.000Z",
        }) as never,
      ),
    ).toThrow(/was not created during/);
    expect(() =>
      requireMatchingOperation(
        entry,
        operationFixture({
          created_at: "2026-08-14T09:59:00.000Z",
          kind: "beneficiary_grant_payment",
          state: "succeeded",
          updated_at: "2026-08-14T09:59:00.000Z",
        }) as never,
      ),
    ).not.toThrow();

    expect(() =>
      bindSubmittedOperation(
        entry,
        operationFixture({
          id: "wrong-operation",
          kind: "transfer",
          state: "succeeded",
        }) as never,
      ),
    ).toThrow(/does not match/);
    expect(entry).toMatchObject({
      response_operation_id: "wrong-operation",
      status: "planned",
    });
    expect(entry.operation_id).toBeUndefined();
  });

  it("durably persists submission evidence before dispatch", async () => {
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const entry = createJournalEntry(
      "transfer.create",
      mutationPath("transfer.create"),
      { quote_id: "quote-1" },
      { quote_id: "quote-1" },
    );
    const journal: Journal = { context, entries: [entry], version: 2 };
    const order: Array<string> = [];
    await dispatchAfterJournal(
      "journal.json",
      journal,
      entry,
      async () => {
        order.push("dispatch");
      },
      async () => {
        order.push("persist");
        expect(entry.submission_started_at).toBeTypeOf("string");
      },
    );
    expect(order).toEqual(["persist", "dispatch"]);

    const dispatch = vi.fn();
    await expect(
      dispatchAfterJournal(
        "journal.json",
        journal,
        entry,
        dispatch,
        async () => {
          throw new Error("sync failed");
        },
      ),
    ).rejects.toThrow(/journal persistence failed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("bounds a financial dispatch and leaves an aborted outcome unresolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-live-dispatch-"));
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const journal: Journal = { context, entries: [], version: 2 };
    try {
      const startedAt = Date.now();
      const send = vi.fn(abortAwareSend());
      await runJournaledMutation({
        action: "beneficiary.create",
        body: { name: "fixture" },
        client: createPerfloClient({ token: "customer-token" }),
        confirm: async () => undefined,
        journal,
        journalPath,
        label: "beneficiary create",
        operationTimeoutMs: 30,
        path: mutationPath("beneficiary.create"),
        send,
      });
      // Exactly once, on both branches. A journaled financial write that silently
      // dispatched twice would satisfy every other assertion here.
      expect(send).toHaveBeenCalledTimes(1);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(journal.entries[0]).toMatchObject({
        status: "unresolved",
        submission_started_at: expect.any(String),
      });
      const persisted = JSON.parse(await readFile(journalPath, "utf8"));
      expect(persisted.entries[0].status).toBe("unresolved");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("leaves a dispatch unresolved when the budget is gone before submission", async () => {
    // The "bounds a financial dispatch" sibling reaches this branch only when the
    // journal's two fsyncs happen to outlast its 30 ms budget, which is a property of
    // the disk rather than of the test -- it held on CI and never locally. A zero budget
    // makes the same branch certain: the deadline has already passed by the time
    // runJournaledMutation builds the signal, so send is handed one that is already
    // aborted rather than one that aborts later. Zero is a test-only lever; the CLI
    // validates PERFLO_LIVE_OPERATION_TIMEOUT_MS at 1 or above, and production reaches
    // this same state through elapsed time on a legal budget.
    const directory = await mkdtemp(
      join(tmpdir(), "perflo-live-spent-budget-"),
    );
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const journal: Journal = { context, entries: [], version: 2 };
    try {
      let signalWasAlreadyAborted: boolean | undefined;
      const send = vi.fn(
        abortAwareSend((signal) => {
          signalWasAlreadyAborted = signal.aborted;
        }),
      );
      await runJournaledMutation({
        action: "beneficiary.create",
        body: { name: "fixture" },
        client: createPerfloClient({ token: "customer-token" }),
        confirm: async () => undefined,
        journal,
        journalPath,
        label: "beneficiary create",
        operationTimeoutMs: 0,
        path: mutationPath("beneficiary.create"),
        send,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(signalWasAlreadyAborted).toBe(true);
      expect(journal.entries[0]).toMatchObject({
        status: "unresolved",
        submission_started_at: expect.any(String),
      });
      const persisted = JSON.parse(await readFile(journalPath, "utf8"));
      expect(persisted.entries[0].status).toBe("unresolved");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("requires matching HTTP and problem statuses before rejecting a mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-live-rejection-"));
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const problem = {
      code: "validation_error",
      detail: "request is invalid",
      fields: null,
      instance: "/v1/beneficiaries",
      refresh_onboarding: false,
      request_id: "request-1",
      retryable: false,
      status: 422,
      submission_uncertain: false,
      title: "Validation error",
      type: "about:blank",
    };
    const runCase = async (
      name: string,
      responseStatus?: number,
    ): Promise<Journal["entries"][number]["status"]> => {
      const journal: Journal = { context, entries: [], version: 2 };
      await runJournaledMutation({
        action: "beneficiary.create",
        body: { name: "fixture" },
        client: createPerfloClient({ token: "customer-token" }),
        confirm: async () => undefined,
        journal,
        journalPath: join(directory, `${name}.json`),
        label: name,
        operationTimeoutMs: 100,
        path: mutationPath("beneficiary.create"),
        send: async () => ({
          error: problem,
          ...(responseStatus === undefined
            ? {}
            : { response: new Response(null, { status: responseStatus }) }),
        }),
      });
      const entry = journal.entries[0];
      if (!entry) {
        throw new Error("mutation did not create a journal entry");
      }
      return entry.status;
    };
    try {
      await expect(runCase("mismatched", 500)).resolves.toBe("unresolved");
      await expect(runCase("missing-response")).resolves.toBe("unresolved");
      await expect(runCase("matching", 422)).resolves.toBe("rejected");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects an operation identity change during polling", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            operationFixture({
              created_at: "2026-08-14T10:00:00.000Z",
              id: "operation-2",
              state: "succeeded",
              updated_at: "2026-08-14T10:00:00.000Z",
            }),
          ),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
    );
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });

    await expect(
      followOperation(
        client,
        operationFixture({
          created_at: "2026-08-14T10:00:00.000Z",
          updated_at: "2026-08-14T10:00:00.000Z",
        }) as never,
        1000,
        async () => undefined,
      ),
    ).rejects.toThrow(/operation changed from operation-1/);
  });

  it("binds journals to one origin and principal and serializes access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-live-api-"));
    const path = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    try {
      const empty = await loadJournal(path, context);
      expect(empty).toEqual({ context, entries: [], version: 2 });
      await withJournalLock(path, async () => {
        await expect(
          withJournalLock(path, async () => undefined),
        ).rejects.toThrow(/already exists/);
        expect(
          JSON.parse(await readFile(`${path}.lock`, "utf8")),
        ).toMatchObject({
          pid: process.pid,
        });
      });
      await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      setEnvironment("PERFLO_LIVE_JOURNAL", path);
      await writeFile(
        `${path}.lock`,
        JSON.stringify({
          created_at: "2026-08-14T09:00:00.000Z",
          pid: 2_147_483_647,
        }),
      );
      await unlockJournal(async (_label, phrase) => {
        expect(phrase).toBe("UNLOCK 2147483647");
      });
      await expect(readFile(`${path}.lock`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const journal: Journal = { context, entries: [], version: 2 };
      await writeFile(path, JSON.stringify(journal));
      await expect(
        loadJournal(path, { ...context, customer_id: "customer-2" }),
      ).rejects.toThrow(/different API origin or authenticated customer/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats repeated matching manual operation evidence as idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-reconcile-"));
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const entry = createJournalEntry(
      "transfer.create",
      mutationPath("transfer.create"),
      { quote_id: "quote-1" },
      { quote_id: "quote-1" },
    );
    entry.operation_id = "operation-1";
    entry.status = "submitted";
    entry.submission_started_at = "2026-08-14T10:00:00.000Z";
    const journal: Journal = { context, entries: [entry], version: 2 };
    const operation = operationFixture({ state: "succeeded" });
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(operation), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    setEnvironment("PERFLO_LIVE_JOURNAL", journalPath);
    try {
      await writeFile(journalPath, JSON.stringify(journal));
      await reconcileJournal(
        createPerfloClient({
          baseUrl: "https://api.example.test",
          fetch: fetch as typeof globalThis.fetch,
          token: "customer-token",
        }),
        context,
        100,
        { entryId: entry.id, kind: "operation", operationId: "operation-1" },
        { confirm: async () => undefined, enabled: true },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
        entries: [{ operation_id: "operation-1", status: "succeeded" }],
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("validates explicit evidence even when the journal is terminal", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "perflo-terminal-evidence-"),
    );
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const entry = createJournalEntry(
      "transfer.create",
      mutationPath("transfer.create"),
      { quote_id: "quote-1" },
      { quote_id: "quote-1" },
    );
    entry.operation_id = "operation-1";
    entry.status = "succeeded";
    entry.submission_started_at = "2026-08-14T10:00:00.000Z";
    const journal: Journal = { context, entries: [entry], version: 2 };
    const fetch = vi.fn(async () => {
      throw new Error("terminal evidence validation must not make a request");
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });
    const reconcile = async (
      reconciliation: Parameters<typeof reconcileJournal>[3],
    ) => {
      await writeFile(journalPath, JSON.stringify(journal));
      return reconcileJournal(client, context, 100, reconciliation, {
        confirm: async () => undefined,
        enabled: true,
      });
    };
    setEnvironment("PERFLO_LIVE_JOURNAL", journalPath);
    try {
      await expect(
        reconcile({
          entryId: entry.id,
          kind: "operation",
          operationId: "operation-2",
        }),
      ).rejects.toThrow(/bound to operation operation-1, not operation-2/);
      await expect(
        reconcile({ entryId: entry.id, kind: "no_operation" }),
      ).rejects.toThrow(/already bound to operation operation-1/);
      await expect(
        reconcile({
          entryId: "missing-entry",
          kind: "operation",
          operationId: "operation-1",
        }),
      ).rejects.toThrow(/no journal entry has ID missing-entry/);
      await expect(
        reconcile({
          entryId: entry.id,
          kind: "operation",
          operationId: "operation-1",
        }),
      ).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not replace a journal operation ID from a mismatched read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-reconcile-id-"));
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const entry = createJournalEntry(
      "transfer.create",
      mutationPath("transfer.create"),
      { quote_id: "quote-1" },
      { quote_id: "quote-1" },
    );
    entry.operation_id = "operation-expected";
    entry.status = "submitted";
    entry.submission_started_at = "2026-08-14T10:00:00.000Z";
    const journal: Journal = { context, entries: [entry], version: 2 };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            operationFixture({ id: "operation-other", state: "succeeded" }),
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    );
    setEnvironment("PERFLO_LIVE_JOURNAL", journalPath);
    try {
      await writeFile(journalPath, JSON.stringify(journal));
      await reconcileJournal(
        createPerfloClient({
          baseUrl: "https://api.example.test",
          fetch: fetch as typeof globalThis.fetch,
          token: "customer-token",
        }),
        context,
        100,
        { kind: "none" },
        { confirm: async () => undefined, enabled: true },
      );
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
        entries: [{ operation_id: "operation-expected", status: "submitted" }],
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a mismatched operation ID during manual attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-attach-id-"));
    const journalPath = join(directory, "journal.json");
    const context: JournalContext = {
      api_origin: "https://api-gateway.perflo.ai",
      customer_id: "customer-1",
      subject: "subject-1",
    };
    const entry = createJournalEntry(
      "transfer.create",
      mutationPath("transfer.create"),
      { quote_id: "quote-1" },
      { quote_id: "quote-1" },
    );
    entry.status = "unresolved";
    entry.submission_started_at = "2026-08-14T10:00:00.000Z";
    const journal: Journal = { context, entries: [entry], version: 2 };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            operationFixture({ id: "operation-other", state: "succeeded" }),
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    );
    setEnvironment("PERFLO_LIVE_JOURNAL", journalPath);
    try {
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(
        reconcileJournal(
          createPerfloClient({
            baseUrl: "https://api.example.test",
            fetch: fetch as typeof globalThis.fetch,
            token: "customer-token",
          }),
          context,
          100,
          {
            entryId: entry.id,
            kind: "operation",
            operationId: "operation-expected",
          },
          { confirm: async () => undefined, enabled: true },
        ),
      ).rejects.toThrow(
        /returned operation-other, expected operation-expected/,
      );
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
        entries: [{ status: "unresolved" }],
      });
      expect(
        JSON.parse(await readFile(journalPath, "utf8")).entries[0],
      ).not.toHaveProperty("operation_id");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps every journal path aligned with its generated operation", async () => {
    const observed: Array<string> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      observed.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ code: "fixture", status: 400 }), {
        headers: { "Content-Type": "application/problem+json" },
        status: 400,
      });
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });
    const headers = {
      "Confirmation-Intent-ID": "confirmation-1",
      "Idempotency-Key": "1234567890abcdef",
    };
    const calls = [
      [
        mutationPath("beneficiary.create"),
        () => createBeneficiary({ body: {} as never, client, headers }),
      ],
      [
        mutationPath("card.create"),
        () => createCard({ body: {} as never, client, headers }),
      ],
      [
        mutationPath("card.freeze", "card-1"),
        () => freezeCard({ client, headers, path: { card_id: "card-1" } }),
      ],
      [
        mutationPath("card.unfreeze", "card-1"),
        () => unfreezeCard({ client, headers, path: { card_id: "card-1" } }),
      ],
      [
        mutationPath("mandate.create"),
        () => createMandate({ body: {} as never, client, headers }),
      ],
      [
        mutationPath("mandate.execute", "mandate-1"),
        () =>
          executeMandate({
            body: {} as never,
            client,
            headers,
            path: { mandate_id: "mandate-1" },
          }),
      ],
      [
        mutationPath("beneficiary_grant.spend", "grant-1"),
        () =>
          spendBeneficiaryGrant({
            body: {} as never,
            client,
            headers,
            path: { grant_id: "grant-1" },
          }),
      ],
      [
        mutationPath("purchase.create"),
        () => createPurchase({ body: {} as never, client, headers }),
      ],
      [
        mutationPath("spending_withdrawal.create"),
        () => createSpendingWithdrawal({ body: {} as never, client, headers }),
      ],
      [
        mutationPath("transfer.create"),
        () => createTransfer({ body: {} as never, client, headers }),
      ],
    ] as const;

    for (const [expectedPath, call] of calls) {
      observed.length = 0;
      await call();
      expect(observed).toEqual([expectedPath]);
    }
  });

  it("never deletes a subscription after an uncertain webhook create", async () => {
    const methods: Array<string> = [];
    let listCall = 0;
    const callbackUrl = "https://receiver.example.test/perflo";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      methods.push(request.method);
      if (request.method === "POST") {
        throw new Error("connection reset after dispatch");
      }
      listCall += 1;
      const subscriptions = [
        {
          created_at: "2026-08-14T09:00:00.000Z",
          id: "existing-subscription",
          url: callbackUrl,
        },
        ...(listCall === 2
          ? [
              {
                created_at: "2020-01-01T00:00:00.000Z",
                id: "concurrent-subscription",
                url: callbackUrl,
              },
            ]
          : []),
      ];
      return new Response(JSON.stringify(subscriptions), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });

    await runWebhook(client, {
      confirm: async () => undefined,
      enabled: true,
      url: callbackUrl,
    });

    expect(methods).toEqual(["GET", "POST", "GET"]);
  });

  it("never deletes a pre-existing ID returned by webhook create", async () => {
    const methods: Array<string> = [];
    const callbackUrl = "https://receiver.example.test/perflo";
    const existing = {
      created_at: "2026-08-14T09:00:00.000Z",
      id: "existing-subscription",
      url: callbackUrl,
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      methods.push(request.method);
      return new Response(
        JSON.stringify(
          request.method === "POST"
            ? { ...existing, signing_secret: "must-not-be-printed" }
            : [existing],
        ),
        {
          headers: { "Content-Type": "application/json" },
          status: request.method === "POST" ? 201 : 200,
        },
      );
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });

    await runWebhook(client, {
      confirm: async () => undefined,
      enabled: true,
      url: callbackUrl,
    });

    expect(methods).toEqual(["GET", "POST", "GET"]);
  });

  it("deletes only the new ID returned by a valid webhook create", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const callbackUrl = "https://receiver.example.test/perflo";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
      });
      if (request.method === "GET") {
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }
      if (request.method === "POST") {
        return new Response(
          JSON.stringify({
            created_at: "2020-01-01T00:00:00.000Z",
            id: "new-subscription",
            signing_secret: "must-not-be-printed",
            url: callbackUrl,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 201,
          },
        );
      }
      return new Response(null, { status: 204 });
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });

    await runWebhook(client, {
      confirm: async () => undefined,
      enabled: true,
      url: callbackUrl,
    });

    expect(requests).toEqual([
      { method: "GET", path: "/v1/webhook-subscriptions" },
      { method: "POST", path: "/v1/webhook-subscriptions" },
      {
        method: "DELETE",
        path: "/v1/webhook-subscriptions/new-subscription",
      },
    ]);
  });

  it("reports the known webhook ID when deletion and reconciliation fail", async () => {
    let requestCount = 0;
    const callbackUrl = "https://receiver.example.test/perflo";
    const logs: Array<string> = [];
    vi.spyOn(console, "log").mockImplementation((...values) => {
      logs.push(values.join(" "));
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        requestCount += 1;
        if (requestCount === 1) {
          return new Response("[]", {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        if (request.method === "POST") {
          return new Response(
            JSON.stringify({
              created_at: "2020-01-01T00:00:00.000Z",
              id: "new-subscription",
              signing_secret: "must-not-be-printed",
              url: callbackUrl,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 201,
            },
          );
        }
        return new Response(
          JSON.stringify({ code: "fixture", detail: "failed", status: 500 }),
          {
            headers: { "Content-Type": "application/problem+json" },
            status: 500,
          },
        );
      }) as typeof globalThis.fetch,
      token: "customer-token",
    });

    await runWebhook(client, {
      confirm: async () => undefined,
      enabled: true,
      url: callbackUrl,
    });

    expect(logs.join("\n")).toContain("subscription ID new-subscription");
    expect(logs.join("\n")).not.toContain("must-not-be-printed");
  });

  it("does not accept connection completion before onboarding connects", async () => {
    const capabilities = capabilitiesFixture();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      const body =
        path === "/v1/perflo-connections"
          ? { account_identifier: null, action: null, status: "connected" }
          : {
              capabilities,
              customer: {
                created_at: "2026-08-14T09:00:00.000Z",
                email: "owner@example.com",
                id: "customer-1",
                locale: "en",
                status: "active",
              },
              kyc_session_available: false,
              perflo_connection: "pending",
            };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status: path === "/v1/perflo-connections" ? 201 : 200,
      });
    });
    const client = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: fetch as typeof globalThis.fetch,
      token: "customer-token",
    });

    await expect(
      ensurePerfloConnection(
        client,
        { perflo_connection: "not_connected" } as never,
        1,
        async () => undefined,
      ),
    ).rejects.toThrow(/onboarding reports pending/);
  });

  it("rejects public-only combinations before making a request", async () => {
    const script = resolve("scripts/live-api.ts");
    await expect(
      execFileAsync(
        process.execPath,
        [script, "--public-only", "--reconcile"],
        {
          cwd: resolve("."),
        },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        "FAIL live API exercise: --public-only cannot run with another option",
      ),
    });
  });

  it("prints the KYC URL from a successful live command", async () => {
    const capabilities = {
      ...capabilitiesFixture(),
      kyc_session: true,
    };
    const verificationUrl =
      "https://verify.identity.example/session/customer-1";
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const key = `${request.method ?? "GET"} ${path}`;
      const bodies: Record<string, unknown> = {
        "GET /cli/devices": {
          data: { devices: [] },
          success: true,
        },
        "GET /v1/identity": {
          actor_type: "customer",
          client_id: null,
          idempotency_replay_window_seconds: 86_400,
          scopes: [],
          server_time: "2026-08-20T10:00:00.000Z",
          subject: "did:privy:customer-1",
          wallet: null,
        },
        "GET /v1/onboarding": {
          capabilities,
          customer: {
            created_at: "2026-08-20T09:00:00.000Z",
            email: "owner@example.com",
            id: "customer-1",
            locale: "en",
            status: "active",
          },
          kyc_session_available: true,
          perflo_account_identifier: "account-1",
          perflo_connection: "connected",
        },
        "GET /v1/operations": [],
        "GET /v1/public-config": {
          app_mark: "P",
          app_name: "Perflo",
          app_name_ar: null,
        },
        "GET /v1/webhook-subscriptions": [],
        "POST /v1/kyc/sessions": {
          expires_at: null,
          kind: "kyc_session",
          poll_after_ms: null,
          url: verificationUrl,
        },
      };
      const body = bodies[key];
      response.writeHead(body === undefined ? 404 : 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify(
          body ?? {
            code: "not_found",
            detail: `Unexpected test request ${key}`,
            status: 404,
          },
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    const script = resolve("scripts/live-api.ts");
    const bootstrap = `
        Object.defineProperty(process.stdin, "isTTY", { value: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true });
        process.argv = [process.execPath, ${JSON.stringify(script)}, "--kyc-session"];
        await import(${JSON.stringify(pathToFileURL(script).href)});
      `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", bootstrap],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          NO_COLOR: "1",
          PERFLO_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          PERFLO_CONFIRMED_ACCOUNT_EMAIL: "owner@example.com",
          PERFLO_CUSTOMER_TOKEN: "customer-token",
          PERFLO_LIVE_REQUEST_TIMEOUT_MS: "2000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let confirmationSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (
        !confirmationSent &&
        Buffer.concat(stdout).includes("Type KYC to continue:")
      ) {
        confirmationSent = true;
        child.stdin.write("KYC\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    try {
      const [exitCode] = (await once(child, "close")) as [number];
      const output = Buffer.concat(stdout)
        .toString("utf8")
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n");
      expect(exitCode, output).toBe(0);
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
      expect(output).toContain(
        `\nOpen the KYC URL in your browser:\n${verificationUrl}\n`,
      );
      expect(output).not.toContain("one-time KYC");
    } finally {
      child.kill();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  }, 15_000);

  it("keeps live credentials out of SDK preparation commands", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.scripts["test:live"]).toBe("node scripts/live-api.ts");
  });

  it("permits HTTPS and loopback API origins but rejects remote HTTP", async () => {
    expect(requireSafeApiBaseUrl("https://api.example.test/v1").origin).toBe(
      "https://api.example.test",
    );
    expect(requireSafeApiBaseUrl("https://api.example.test/v1/").origin).toBe(
      "https://api.example.test",
    );
    expect(requireSafeApiBaseUrl("http://127.0.0.1:8787").origin).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => requireSafeApiBaseUrl("http://example.com")).toThrow(
      /must be HTTPS/,
    );

    await expect(
      execFileAsync(
        process.execPath,
        [resolve("scripts/live-api.ts"), "--public-only"],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            PERFLO_API_BASE_URL: "http://example.com",
          },
        },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("PERFLO_API_BASE_URL must be HTTPS"),
    });
  });

  it("times out a stalled public smoke and still prints its summary", async () => {
    const server = createServer(() => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    try {
      await expect(
        execFileAsync(
          process.execPath,
          [resolve("scripts/live-api.ts"), "--public-only"],
          {
            cwd: resolve("."),
            env: {
              ...process.env,
              PERFLO_API_BASE_URL: `http://127.0.0.1:${address.port}`,
              PERFLO_LIVE_REQUEST_TIMEOUT_MS: "40",
            },
            timeout: 2000,
          },
        ),
      ).rejects.toMatchObject({
        stdout: expect.stringMatching(
          /FAIL public config:[\s\S]*Summary: 0 passed, 1 failed, 0 skipped/,
        ),
      });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("rejects contradictory reconciliation evidence before a request", () => {
    setEnvironment("PERFLO_LIVE_RECONCILE_ENTRY_ID", "entry-1");
    expect(() => readLiveConfig(new Set(["--reconcile"]))).toThrow(
      /requires operation or no-operation evidence/,
    );
    setEnvironment("PERFLO_LIVE_RECONCILE_NO_OPERATION", "entry-2");
    expect(() => readLiveConfig(new Set(["--reconcile"]))).toThrow(
      /must equal PERFLO_LIVE_RECONCILE_ENTRY_ID/,
    );
  });

  it("aborts connection and operation HTTP calls at their deadlines", async () => {
    const requestDeadlineMs = 250;
    let requests = 0;
    const server = createServer(() => {
      requests += 1;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    const client = createPerfloClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "customer-token",
    });
    try {
      const connectionStartedAt = Date.now();
      await expect(
        ensurePerfloConnection(
          client,
          { perflo_connection: "not_connected" } as never,
          requestDeadlineMs,
          async () => undefined,
        ),
      ).rejects.toThrow(/connection start failed/);
      expect(Date.now() - connectionStartedAt).toBeLessThan(1000);

      const operationStartedAt = Date.now();
      await expect(
        followOperation(
          client,
          operationFixture() as never,
          requestDeadlineMs,
          async () => undefined,
        ),
      ).rejects.toThrow(/operation read failed/);
      expect(Date.now() - operationStartedAt).toBeLessThan(1000);
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("does not poll after a browser action expires during its delay", async () => {
    let connectionPolls = 0;
    const callbackUrl = "https://app.perflo.ai/connect/fixture";
    const connectionClient = createPerfloClient({
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            action: {
              expires_at: new Date(Date.now() + 20).toISOString(),
              kind: "connect",
              poll_after_ms: 1000,
              url: callbackUrl,
            },
            status: "pending",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: connectionPolls++ === 0 ? 201 : 200,
          },
        )) as typeof globalThis.fetch,
      token: "customer-token",
    });
    await expect(
      ensurePerfloConnection(
        connectionClient,
        { perflo_connection: "not_connected" } as never,
        1000,
        async () => undefined,
        async (milliseconds) =>
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, milliseconds + 5),
          ),
        async () => "",
      ),
    ).rejects.toThrow(/browser action expired/);
    expect(connectionPolls).toBe(1);

    let operationPolls = 0;
    await expect(
      followOperation(
        createPerfloClient({
          baseUrl: "https://api.example.test",
          fetch: (async () => {
            operationPolls += 1;
            return new Response("{}", { status: 200 });
          }) as typeof globalThis.fetch,
          token: "customer-token",
        }),
        operationFixture({
          action_required: {
            expires_at: new Date(Date.now() + 20).toISOString(),
            kind: "grant_approval",
            poll_after_ms: 1000,
            url: "https://app.perflo.ai/approve/fixture",
          },
          state: "requires_action",
        }) as never,
        1000,
        async (milliseconds) =>
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, milliseconds + 5),
          ),
        async () => "",
      ),
    ).rejects.toThrow(/browser action expired/);
    expect(operationPolls).toBe(0);
  });

  it("rejects invalid selected fixtures before any network request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    try {
      await expect(
        execFileAsync(
          process.execPath,
          [resolve("scripts/live-api.ts"), "--mutations"],
          {
            cwd: resolve("."),
            env: {
              ...process.env,
              PERFLO_API_BASE_URL: `http://127.0.0.1:${address.port}`,
              PERFLO_LIVE_CARD_ACTION: '{"action":"close","card_id":"card-1"}',
            },
          },
        ),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining("PERFLO_LIVE_CARD_ACTION requires"),
      });
      expect(requests).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
