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

async function runGenerator(
  fixture: Fixture,
  mode: "--check" | "--write" = "--write",
) {
  return execFileAsync(
    process.execPath,
    [generatorPath, mode, fixture.pagePath],
    {
      env: {
        ...process.env,
        PERFLO_SDK_REFERENCE_ROOT: fixture.directory,
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
      Accounts: 2,
      Activity: 1,
      Beneficiaries: 5,
      Cards: 7,
      Identity: 3,
      KYC: 2,
      Mandates: 11,
      Onboarding: 4,
      Operations: 4,
      "Perflo device tokens": 5,
      Services: 7,
      Spending: 3,
      Transfers: 2,
      Webhooks: 3,
    };

    expect(rows).toHaveLength(59);
    expect(new Set(functionNames).size).toBe(59);
    expect(page.match(/^### /gmu)).toHaveLength(14);
    expect(result.stdout).toContain("59 operations across 14 domains");
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
    expect(operationRow(page, "createPurchase")).toContain(
      "| `body` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "executeMandate")).toContain(
      "| `body` (required)<br />`path` (required)<br />`headers` (required) | Bearer |",
    );
    expect(operationRow(page, "createPurchase")).toContain(
      "`CreatePurchaseData`<br />`CreatePurchaseResponse` / `CreatePurchaseResponses`<br />`CreatePurchaseError` / `CreatePurchaseErrors`",
    );
  });

  it("renders the effective OpenAPI authentication policy", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");
    const publicRows = operationRows(page).filter((row) =>
      row.includes("| Public |"),
    );

    expect(publicRows).toHaveLength(5);
    expect(
      publicRows.map((row) => row.match(/^\| `([^`]+)`/u)?.[1]).sort(),
    ).toEqual(
      [
        "pollDevice",
        "startDevice",
        "refreshToken",
        "redeemConnectCode",
        "publicConfig",
      ].sort(),
    );
    expect(
      operationRows(page).filter((row) => row.includes("| Bearer |")),
    ).toHaveLength(54);
  });

  it("escapes MDX-sensitive OpenAPI text", async () => {
    const fixture = await createFixture();
    const openApiPath = resolve(fixture.directory, "openapi.json");
    const document = JSON.parse(await readFile(openApiPath, "utf8"));
    const originalDomain = "Accounts";
    const escapedDomain = "Accounts & {funds} <details> `lookup` | values";
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
    await writeFile(openApiPath, JSON.stringify(document));

    await runGenerator(fixture);
    const page = await readFile(fixture.pagePath, "utf8");

    expect(page).toContain(
      "### Accounts &amp; &#123;funds&#125; &lt;details&gt; &#96;lookup&#96; &#124; values",
    );
    expect(operationRow(page, "accounts")).toContain(
      "Read &#123;account&#125; &lt;details&gt; &amp; &#96;quoted&#96; &#124; row",
    );
  });

  it("detects a stale page without modifying it", async () => {
    const fixture = await createFixture();
    await runGenerator(fixture);
    await runGenerator(fixture, "--check");
    const current = await readFile(fixture.pagePath, "utf8");
    const stale = current.replace("List deposit accounts", "Stale purpose");
    await writeFile(fixture.pagePath, stale);

    await expect(runGenerator(fixture, "--check")).rejects.toMatchObject({
      stderr: expect.stringContaining("out of date"),
    });
    expect(await readFile(fixture.pagePath, "utf8")).toBe(stale);

    await runGenerator(fixture);
    await expect(runGenerator(fixture, "--check")).resolves.toMatchObject({
      stdout: expect.stringContaining("reference check passed"),
    });
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

  it("rejects unmatched and duplicate operations", async () => {
    const unmatched = await createFixture();
    const openApiPath = resolve(unmatched.directory, "openapi.json");
    const document = JSON.parse(await readFile(openApiPath, "utf8"));
    document.paths["/v1/test-only"] = {
      get: {
        operationId: "test_only",
        security: [{ BearerAuth: [] }],
        summary: "Test only",
        tags: ["Accounts"],
      },
    };
    await writeFile(openApiPath, JSON.stringify(document));

    await expect(runGenerator(unmatched)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI operation GET /v1/test-only has no generated SDK function",
      ),
    });

    const duplicate = await createFixture();
    const sdkPath = resolve(duplicate.directory, "src/generated/sdk.gen.ts");
    const sdkSource = await readFile(sdkPath, "utf8");
    const start = sdkSource.indexOf("export const accounts =");
    const end = sdkSource.indexOf("/**", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = sdkSource
      .slice(start, end)
      .replace("export const accounts =", "export const accountsDuplicate =");
    await writeFile(sdkPath, `${sdkSource}\n${declaration}`);

    await expect(runGenerator(duplicate)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Duplicate generated SDK operation: GET /v1/accounts",
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
