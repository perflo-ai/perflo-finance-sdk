import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = resolve(import.meta.dirname, "..");
const generatorPath = resolve(
  packageDirectory,
  "scripts/generate-sdk-reference.mjs",
);
const temporaryDirectories: Array<string> = [];
const startMarker = "{/* SDK_REFERENCE_START */}";
const endMarker = "{/* SDK_REFERENCE_END */}";
const canonicalPage = `<p>Before the generated region.</p>
${startMarker}
stale content
${endMarker}
<p>After the generated region.</p>
`;
const inputPaths = [
  "openapi.json",
  "src/generated/sdk.gen.ts",
  "src/generated/types.gen.ts",
  "src/index.ts",
];

interface Fixture {
  directory: string;
  pagePath: string;
}

async function createFixture(page = canonicalPage): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "perflo-sdk-reference-"));
  temporaryDirectories.push(directory);
  for (const path of inputPaths) {
    const destination = resolve(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      destination,
      await readFile(resolve(packageDirectory, path), "utf8"),
    );
  }
  const pagePath = resolve(directory, "typescript-sdk.mdx");
  await writeFile(pagePath, page);
  return { directory, pagePath };
}

async function mutateOpenApi(
  fixture: Fixture,
  mutate: (document: ReturnType<typeof JSON.parse>) => void,
) {
  const openApiPath = resolve(fixture.directory, "openapi.json");
  const document = JSON.parse(await readFile(openApiPath, "utf8"));
  mutate(document);
  await writeFile(openApiPath, JSON.stringify(document));
}

async function runGenerator(
  fixture: Fixture,
  mode: "--check" | "--write" = "--write",
  openApiPath?: string,
) {
  return execFileAsync(
    process.execPath,
    [generatorPath, mode, fixture.pagePath],
    {
      env: {
        ...process.env,
        PERFLO_SDK_REFERENCE_ROOT: fixture.directory,
        ...(openApiPath === undefined
          ? {}
          : { PERFLO_SDK_OPENAPI: openApiPath }),
      },
    },
  );
}

async function replaceExactly(
  path: string,
  original: string,
  replacement: string,
) {
  const source = await readFile(path, "utf8");
  expect(source.split(original)).toHaveLength(2);
  await writeFile(path, source.replace(original, replacement));
}

async function appendAccountsOperation(
  fixture: Fixture,
  functionName: string,
  path = "/v1/accounts",
) {
  const sdkPath = resolve(fixture.directory, "src/generated/sdk.gen.ts");
  const source = await readFile(sdkPath, "utf8");
  const start = source.indexOf("export const accounts =");
  const end = source.indexOf("/**", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const declaration = source
    .slice(start, end)
    .replace("export const accounts =", `export const ${functionName} =`)
    .replace('url: "/v1/accounts"', `url: ${JSON.stringify(path)}`);
  await writeFile(sdkPath, `${source}\n${declaration}`);
}

function operationRows(source: string): Array<string> {
  return source
    .split("\n")
    .filter((line) => /^\| `[$\w]+`(?:<br \/>Alias: `[$\w]+`)? \|/u.test(line));
}

function operationRow(source: string, functionName: string): string {
  const row = operationRows(source).find((line) =>
    line.startsWith(`| \`${functionName}\``),
  );
  expect(row, `missing ${functionName} row`).toBeDefined();
  return row ?? "";
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SDK reference generator", () => {
  it("writes all operations grouped by the current OpenAPI domains", async () => {
    const fixture = await createFixture();

    const result = await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");
    const rows = operationRows(page);
    const functionNames = rows.map((row) => row.match(/^\| `([^`]+)`/u)?.[1]);
    const domainCounts = {
      Accounts: 4,
      Activity: 1,
      Beneficiaries: 8,
      Cards: 16,
      Identity: 3,
      KYC: 2,
      Mandates: 13,
      Onboarding: 4,
      Operations: 4,
      "Pay per use: account and sub-accounts": 7,
      "Pay per use: discovery": 5,
      "Pay per use: keys": 7,
      "Pay per use: payments": 4,
      "Pay per use: resources": 2,
      "Perflo device tokens": 7,
      Services: 7,
      Spending: 3,
      Transfers: 2,
      Webhooks: 3,
    };

    expect(rows).toHaveLength(102);
    expect(new Set(functionNames).size).toBe(102);
    expect(page.match(/^### /gmu)).toHaveLength(19);
    expect(result.stdout).toContain("102 operations across 19 domains");
    expect(
      page.startsWith(`<p>Before the generated region.</p>\n${startMarker}\n`),
    ).toBe(true);
    expect(
      page.endsWith(`${endMarker}\n<p>After the generated region.</p>\n`),
    ).toBe(true);
    for (const [domain, count] of Object.entries(domainCounts)) {
      const section = page.split(`### ${domain}\n`)[1]?.split("\n### ")[0];
      expect(operationRows(section ?? ""), domain).toHaveLength(count);
    }
  });

  it("annotates the two public operation aliases", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");

    expect(operationRow(page, "activity")).toContain(
      "`activity`<br />Alias: `listActivity`",
    );
    expect(operationRow(page, "services")).toContain(
      "`services`<br />Alias: `listServices`",
    );
    expect(
      operationRows(page).filter((row) => row.includes("Alias:")),
    ).toHaveLength(2);
  });

  it("renders required and optional request groups and generated types", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");

    expect(operationRow(page, "accounts")).toContain("| None | Bearer |");
    expect(operationRow(page, "accountEndorsement")).toContain(
      "| `query` (required) | Bearer |",
    );
    expect(operationRow(page, "createAccount")).toContain(
      "| `body` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "activity")).toContain(
      "| `query` (optional) | Bearer |",
    );
    expect(operationRow(page, "revokeToken")).toContain(
      "| `body` (optional) | Bearer |",
    );
    expect(operationRow(page, "serviceCapabilities")).toContain(
      "| `query` (required) | Bearer |",
    );
    expect(operationRow(page, "getService")).toContain(
      "| `path` (required)<br />`query` (optional) | Bearer |",
    );
    expect(operationRow(page, "renameBeneficiary")).toContain(
      "| `body` (required)<br />`path` (required) | Bearer |",
    );
    expect(operationRow(page, "createPurchase")).toContain(
      "| `body` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "createCardWithdrawal")).toContain(
      "| `body` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "executeMandate")).toContain(
      "| `body` (required)<br />`path` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "createPurchase")).toContain(
      "`CreatePurchaseData`<br />`CreatePurchaseResponse` / `CreatePurchaseResponses`<br />`CreatePurchaseError` / `CreatePurchaseErrors`",
    );
    expect(operationRow(page, "createCardWithdrawal")).toContain(
      "`CreateCardWithdrawalData`<br />`CreateCardWithdrawalResponse` / `CreateCardWithdrawalResponses`<br />`CreateCardWithdrawalError` / `CreateCardWithdrawalErrors`",
    );
    expect(
      operationRow(page, "payPerUseRejectBulkSubAccountDeletion"),
    ).toContain(
      "`PayPerUseRejectBulkSubAccountDeletionData`<br />`unknown`<br />`PayPerUseRejectBulkSubAccountDeletionError` / `PayPerUseRejectBulkSubAccountDeletionErrors`",
    );
  });

  it("renders the effective OpenAPI authentication policy", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");
    const publicRows = operationRows(page).filter((row) =>
      row.includes("| Public |"),
    );

    expect(publicRows).toHaveLength(9);
    expect(
      publicRows.map((row) => row.match(/^\| `([^`]+)`/u)?.[1]).sort(),
    ).toEqual(
      [
        "pollDevice",
        "pollSign",
        "startDevice",
        "payPerUseGetCapability",
        "payPerUseGetVendor",
        "payPerUseListCapabilities",
        "refreshToken",
        "redeemConnectCode",
        "publicConfig",
      ].sort(),
    );
    expect(
      operationRows(page).filter((row) => row.includes("| Bearer |")),
    ).toHaveLength(93);
  });

  it("escapes MDX-sensitive OpenAPI text", async () => {
    const fixture = await createFixture();
    const originalDomain = "Accounts";
    const escapedDomain = "Accounts & {funds} <details> `lookup` | values";
    await mutateOpenApi(fixture, (document) => {
      const tag = document.tags.find(
        (candidate: { name?: string }) => candidate.name === originalDomain,
      );
      expect(tag).toBeDefined();
      tag.name = escapedDomain;
      for (const pathItem of Object.values(document.paths) as Array<
        Record<string, { tags?: Array<string> }>
      >) {
        for (const operation of Object.values(pathItem)) {
          if (operation.tags?.[0] === originalDomain) {
            operation.tags = [escapedDomain];
          }
        }
      }
      document.paths["/v1/accounts"].get.summary =
        "Read {account}\n<details> & `quoted` | row";
    });

    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");

    expect(page).toContain(
      "### Accounts &amp; &#123;funds&#125; &lt;details&gt; &#96;lookup&#96; &#124; values",
    );
    expect(operationRow(page, "accounts")).toContain(
      "Read &#123;account&#125; &lt;details&gt; &amp; &#96;quoted&#96; &#124; row",
    );
  });

  it("accepts a current page", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);

    await expect(runGenerator(fixture, "--check")).resolves.toMatchObject({
      stdout: expect.stringContaining("reference check passed"),
    });
  });

  it("reads OpenAPI from PERFLO_SDK_OPENAPI without relocating other inputs", async () => {
    const fixture = await createFixture();
    const rootOpenApiPath = resolve(fixture.directory, "openapi.json");
    const overridePath = resolve(fixture.directory, "resolved-openapi.json");
    await writeFile(overridePath, await readFile(rootOpenApiPath, "utf8"));
    await writeFile(rootOpenApiPath, "{}");

    await expect(
      runGenerator(fixture, "--write", overridePath),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("102 operations across 19 domains"),
    });
  });

  it("detects a stale page without modifying it", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    const current = await readFile(fixture.pagePath, "utf8");
    const stale = current.replace("List deposit accounts", "Stale purpose");
    await writeFile(fixture.pagePath, stale);

    await expect(runGenerator(fixture, "--check")).rejects.toMatchObject({
      stderr: expect.stringContaining("out of date"),
    });
    expect(await readFile(fixture.pagePath, "utf8")).toBe(stale);
  });

  it.each([
    ["missing start", `${endMarker}\n`],
    ["missing end", `${startMarker}\n`],
    ["duplicate start", `${startMarker}\n${startMarker}\n${endMarker}\n`],
    ["duplicate end", `${startMarker}\n${endMarker}\n${endMarker}\n`],
  ])("rejects %s markers", async (_name, page) => {
    const fixture = await createFixture(page);

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("Expected exactly one"),
    });
  });

  it.each([
    "export let generatedMetadata;",
    "export const generatedMetadata;",
  ])("skips an exported variable that declares no operation: %s", async (declaration) => {
    const fixture = await createFixture();
    const sdkPath = resolve(fixture.directory, "src/generated/sdk.gen.ts");
    const source = await readFile(sdkPath, "utf8");
    await writeFile(sdkPath, `${source}\n${declaration}\n`);

    await expect(runGenerator(fixture)).resolves.toMatchObject({
      stdout: expect.stringContaining("102 operations across 19 domains"),
    });
  });

  it("rejects an OpenAPI operation without a generated SDK function", async () => {
    const unmatched = await createFixture();
    await mutateOpenApi(unmatched, (document) => {
      document.paths["/v1/test-only"] = {
        get: {
          operationId: "test_only",
          responses: { 200: { description: "OK" } },
          security: [{ BearerAuth: [] }],
          summary: "Test only",
          tags: ["Accounts"],
        },
      };
    });

    await expect(runGenerator(unmatched)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI operation GET /v1/test-only has no generated SDK function",
      ),
    });
  });

  it("rejects duplicate generated operations", async () => {
    const duplicate = await createFixture();
    await appendAccountsOperation(duplicate, "accountsDuplicate");

    await expect(runGenerator(duplicate)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Duplicate generated operation GET /v1/accounts",
      ),
    });
  });

  it("rejects a generated SDK function whose route is absent from OpenAPI", async () => {
    const fixture = await createFixture();
    await appendAccountsOperation(fixture, "sdkOnly", "/v1/sdk-only");

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated SDK function sdkOnly has no OpenAPI operation: GET /v1/sdk-only",
      ),
    });
  });

  it.each([
    [
      "123getURL",
      "OpenAPI operation 123getURL generates 123GetUrl, which the generator sanitizes",
    ],
    [
      "verify_2fa",
      "OpenAPI operation GET /v1/accounts maps to verify2Fa, not accounts",
    ],
    [
      "get_3ds_status",
      "OpenAPI operation GET /v1/accounts maps to get3DsStatus, not accounts",
    ],
    [
      "get_sha256hash",
      "OpenAPI operation GET /v1/accounts maps to getSha256Hash, not accounts",
    ],
    [
      "list_ipv4addresses",
      "OpenAPI operation GET /v1/accounts maps to listIpv4Addresses, not accounts",
    ],
    [
      "pay_per_use_a1url",
      "OpenAPI operation GET /v1/accounts maps to payPerUseA1Url, not accounts",
    ],
    ["a3a", "OpenAPI operation GET /v1/accounts maps to a3A, not accounts"],
    [
      "a$&",
      "OpenAPI operation a$& generates a$&, which the generator sanitizes",
    ],
    [
      "fetch",
      "OpenAPI operation fetch generates fetch, which the generator reserves and would suffix",
    ],
  ])("uses generator naming for operationId %s", async (operationId, message) => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/v1/accounts"].get.operationId = operationId;
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(message),
    });
  });

  it.each([
    "a3a.",
    "a.b",
  ])("rejects nested operationId %s before naming", async (operationId) => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/v1/accounts"].get.operationId = operationId;
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `OpenAPI operation ${operationId} carries a nesting delimiter, which the generator normalizes before naming, and this module does not model that normalization`,
      ),
    });
  });

  it("rejects operationIds that collide under the pinned operation profile", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      const operation = document.paths["/v1/accounts"].get;
      document.paths = {
        "/collision-a": {
          get: { ...operation, operationId: "a3ß" },
        },
        "/collision-b": {
          get: { ...operation, operationId: "a3_ß" },
        },
      };
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI operations a3ß and a3_ß both generate a3SS",
      ),
    });
  });

  it("rejects a legal operationId that maps to a different SDK name", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/v1/accounts"].get.operationId = "account_list";
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI operation GET /v1/accounts maps to accountList, not accounts: src/generated is stale — run pnpm run generate. If it is current, this cross-check's naming assumption no longer holds and the check should be dropped.",
      ),
    });
  });

  it("rejects an OpenAPI operation without responses", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      delete document.paths["/v1/accounts"].get.responses;
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("must have responses"),
    });
  });

  it("rejects an OpenAPI document with no operations", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths = {};
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI document has no operations"),
    });
  });

  it.each([
    "null",
    "[]",
    "42",
  ])("rejects non-object OpenAPI document %s", async (source) => {
    const fixture = await createFixture();
    await writeFile(resolve(fixture.directory, "openapi.json"), source);

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI document must be an object"),
    });
  });

  it("rejects a malformed bearer scheme with only anonymous operations", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths = { "/v1/accounts": document.paths["/v1/accounts"] };
      document.security = [];
      delete document.paths["/v1/accounts"].get.security;
      document.components.securitySchemes.BearerAuth = { type: "apiKey" };
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI components.securitySchemes.BearerAuth must be an HTTP bearer scheme",
      ),
    });
  });

  it("rejects path-item references instead of omitting their operations", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/referenced"] = {
        $ref: "#/components/pathItems/Referenced",
      };
    });

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI path item /referenced uses an unsupported reference; it must be resolved before generation",
      ),
    });
  });

  it("rejects aliases to unknown generated operations", async () => {
    const fixture = await createFixture();
    await replaceExactly(
      resolve(fixture.directory, "src/index.ts"),
      "activity as listActivity,",
      "missingOperation as listActivity,",
    );

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Unknown generated operation alias: missingOperation as listActivity",
      ),
    });
  });

  it.each([
    ["malformed request type", "malformed"],
    ["mismatched request URL", "url"],
    ["mismatched function binding", "binding"],
  ])("rejects %s", async (_name, mutation) => {
    const fixture = await createFixture();
    if (mutation === "binding") {
      await replaceExactly(
        resolve(fixture.directory, "src/generated/sdk.gen.ts"),
        "Options<AccountsData, ThrowOnError>",
        "Options<ActivityData, ThrowOnError>",
      );
    } else {
      const typesPath = resolve(
        fixture.directory,
        "src/generated/types.gen.ts",
      );
      const source = await readFile(typesPath, "utf8");
      const start = source.indexOf("export type AccountsData =");
      const end = source.indexOf("export type AccountsErrors =", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const original = source.slice(start, end);
      const replacement =
        mutation === "malformed"
          ? "export type AccountsData = string;\n\n"
          : original.replace(
              'url: "/v1/accounts";',
              'url: "/v1/not-accounts";',
            );
      await writeFile(typesPath, source.replace(original, replacement));
    }

    await expect(runGenerator(fixture)).rejects.toMatchObject({
      stderr: expect.stringMatching(/AccountsData|accounts/u),
    });
  });
});
