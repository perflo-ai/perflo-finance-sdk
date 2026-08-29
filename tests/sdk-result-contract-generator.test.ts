import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = resolve(import.meta.dirname, "..");
const patchPath = resolve(
  packageDirectory,
  "scripts/patch-sdk-result-contract.mjs",
);
const temporaryDirectories: Array<string> = [];

const unpatchedOptions = `export type Options<
  TData extends TDataShape = TDataShape,
  ThrowOnError extends boolean = boolean,
  TResponse = unknown,
> = Options2<TData, ThrowOnError, TResponse> & {
  /**
   * You can provide a client instance returned by \`createClient()\` instead of
   * individual options. This might be also useful if you want to implement a
   * custom client.
   */
  client: Client;
  /**
   * You can pass arbitrary values through the \`meta\` object. This can be
   * used to access values that aren't defined as part of the SDK function.
   */
  meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};`;
const sdkSource = `${unpatchedOptions}

export const getWidget = <ThrowOnError extends boolean = false>(
  options: Options<GetWidgetData, ThrowOnError>,
): RequestResult<GetWidgetResponses, GetWidgetErrors, ThrowOnError> =>
  options.client.get<GetWidgetResponses, GetWidgetErrors, ThrowOnError>({
    url: "/widgets/{widget_id}",
    ...options,
  });
`;
const referencedSdkOperation = `export const getReferenced = <ThrowOnError extends boolean = false>(
  options: Options<GetWidgetData, ThrowOnError>,
): RequestResult<GetWidgetResponses, GetWidgetErrors, ThrowOnError> =>
  options.client.get<GetWidgetResponses, GetWidgetErrors, ThrowOnError>({
    url: "/referenced",
    ...options,
  });
`;
const singleLineSdkSource = sdkSource.replace(
  `{
    url: "/widgets/{widget_id}",
    ...options,
  }`,
  `{ url: "/widgets/{widget_id}", ...options }`,
);
const clientSource = `if (
          response.status === 204 ||
          response.headers.get("Content-Length") === "0"
        ) {
  return {};
}

switch (parseAs) {
  case "json": {
            // Some servers return 200 with no Content-Length and empty body.
            // response.json() would throw; read as text and parse if non-empty.
            const text = await response.text();
            data = text ? JSON.parse(text) : {};
            break;
          }
}
`;
const clientTypesSource = `export type RequestResult<
  TData = unknown,
  TError = unknown,
> = {
  data: undefined;
  error: TError extends Record<string, unknown>
                  ? TError[keyof TError]
                  : TError;
};
`;

interface Fixture {
  clientPath: string;
  clientTypesPath: string;
  directory: string;
  sdkPath: string;
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "perflo-result-contract-"));
  temporaryDirectories.push(directory);
  const generatedDirectory = resolve(directory, "src/generated");
  const clientDirectory = resolve(generatedDirectory, "client");
  const clientPath = resolve(clientDirectory, "client.gen.ts");
  const clientTypesPath = resolve(clientDirectory, "types.gen.ts");
  const sdkPath = resolve(generatedDirectory, "sdk.gen.ts");
  await mkdir(clientDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(directory, "openapi.json"),
      JSON.stringify({
        paths: {
          "/widgets/{widget_id}": {
            get: { operationId: "get_widget" },
          },
        },
      }),
    ),
    writeFile(clientPath, clientSource),
    writeFile(clientTypesPath, clientTypesSource),
    writeFile(sdkPath, sdkSource),
  ]);
  return { clientPath, clientTypesPath, directory, sdkPath };
}

async function runPatch(fixture: Fixture, openApiPath?: string) {
  return execFileAsync(process.execPath, [patchPath], {
    env: {
      ...process.env,
      PERFLO_SDK_RESULT_CONTRACT_ROOT: fixture.directory,
      ...(openApiPath === undefined ? {} : { PERFLO_SDK_OPENAPI: openApiPath }),
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SDK result contract patch", () => {
  it("forces JSON field results and strict non-204 decoding", async () => {
    const fixture = await createFixture();

    const first = await runPatch(fixture);
    const firstClient = await readFile(fixture.clientPath, "utf8");
    const firstClientTypes = await readFile(fixture.clientTypesPath, "utf8");
    const firstSdk = await readFile(fixture.sdkPath, "utf8");
    const second = await runPatch(fixture);

    expect(first.stdout).toContain(
      "Enforced JSON field results for 1 generated operations",
    );
    expect(second.stdout).toContain(
      "Enforced JSON field results for 1 generated operations",
    );
    expect(firstSdk).toContain(
      '    ...options,\n    parseAs: "json",\n    responseStyle: "fields",\n',
    );
    expect(firstSdk).toContain(
      'Omit<\n  Options2<TData, ThrowOnError, TResponse>,\n  "parseAs" | "responseStyle"\n>',
    );
    expect(firstSdk).toContain(
      'type GeneratedOperationClient = Omit<Client, "getConfig" | "setConfig">',
    );
    expect(firstSdk).toContain('parseAs?: "json";');
    expect(firstSdk).toContain('responseStyle?: "fields";');
    expect(firstClient).toContain("if (response.status === 204) {");
    expect(firstClient).not.toContain('headers.get("Content-Length")');
    expect(firstClient).toContain("data = await response.json();");
    expect(firstClient).not.toContain("data = text ? JSON.parse(text) : {};");
    expect(firstClientTypes).toContain("_TError = unknown");
    expect(firstClientTypes).toContain("error: unknown;");
  });

  it("forces JSON field results in a single-line client-call object", async () => {
    const fixture = await createFixture();
    expect(singleLineSdkSource).not.toBe(sdkSource);
    await writeFile(fixture.sdkPath, singleLineSdkSource);

    await runPatch(fixture);
    const patchedSdk = await readFile(fixture.sdkPath, "utf8");

    expect(patchedSdk).toContain(
      `>({
    url: "/widgets/{widget_id}",
    ...options,
    parseAs: "json",
    responseStyle: "fields",
  });`,
    );
  });

  it("matches operations by route without reading operationId", async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.directory, "openapi.json"),
      JSON.stringify({
        paths: {
          "/widgets/{widget_id}": {
            get: { operationId: "getURL" },
          },
        },
      }),
    );

    await runPatch(fixture);

    await expect(readFile(fixture.sdkPath, "utf8")).resolves.toContain(
      '    parseAs: "json",\n    responseStyle: "fields",\n',
    );
  });

  it("reads OpenAPI from PERFLO_SDK_OPENAPI without relocating generated inputs", async () => {
    const fixture = await createFixture();
    const rootOpenApiPath = resolve(fixture.directory, "openapi.json");
    const overridePath = resolve(fixture.directory, "resolved-openapi.json");
    await writeFile(overridePath, await readFile(rootOpenApiPath, "utf8"));
    await writeFile(rootOpenApiPath, JSON.stringify({ paths: {} }));

    await runPatch(fixture, overridePath);

    await expect(readFile(fixture.sdkPath, "utf8")).resolves.toContain(
      '    parseAs: "json",\n    responseStyle: "fields",\n',
    );
  });

  it("rejects a non-object path item with its path", async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.directory, "openapi.json"),
      JSON.stringify({ paths: { "/widgets/{widget_id}": null } }),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Invalid OpenAPI path item: /widgets/{widget_id}",
      ),
    });
  });

  it("rejects an OpenAPI document with no operations", async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.directory, "openapi.json"),
      JSON.stringify({ paths: {} }),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI document has no operations"),
    });
  });

  it("rejects a referenced path item beside an inline operation", async () => {
    const fixture = await createFixture();
    await Promise.all([
      writeFile(
        resolve(fixture.directory, "openapi.json"),
        JSON.stringify({
          paths: {
            "/widgets/{widget_id}": {
              get: { operationId: "get_widget" },
            },
            "/referenced": {
              $ref: "#/components/pathItems/Referenced",
            },
          },
        }),
      ),
      writeFile(fixture.sdkPath, `${sdkSource}\n${referencedSdkOperation}`),
    ]);

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI path item /referenced uses an unsupported reference; it must be resolved before generation",
      ),
    });
  });

  it("rejects a generated route missing from the OpenAPI traversal", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.sdkPath, `${sdkSource}\n${referencedSdkOperation}`);

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated SDK operation mismatch: expected 1, found 2; unexpected GET /referenced",
      ),
    });
  });

  it("skips generated SDK exports that are not operations", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sdkPath,
      `${sdkSource}\nexport const supportedMediaTypes = ["application/json"];\n`,
    );

    await runPatch(fixture);

    const patchedSdk = await readFile(fixture.sdkPath, "utf8");
    expect(patchedSdk).toContain(
      '    parseAs: "json",\n    responseStyle: "fields",\n',
    );
    expect(patchedSdk).toContain(
      'export const supportedMediaTypes = ["application/json"];',
    );
  });

  it("rejects an OpenAPI and generated SDK operation mismatch", async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.directory, "openapi.json"),
      JSON.stringify({
        paths: { "/missing": { get: { operationId: "missing" } } },
      }),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("Generated SDK operation mismatch"),
    });
  });

  it("rejects a non-field or non-final response style", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sdkPath,
      sdkSource.replace(
        "    ...options,\n",
        '    responseStyle: "data",\n    ...options,\n',
      ),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("must force JSON field results last"),
    });
  });

  it("rejects an unknown generated operation options shape", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sdkPath,
      sdkSource.replace(unpatchedOptions, "export type Options = unknown;"),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated operation Options type mismatch",
      ),
    });
  });

  it("rejects an unknown generated JSON success parser", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.clientPath,
      clientSource.replace(
        "data = text ? JSON.parse(text) : {};",
        "data = text;",
      ),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated JSON success handling mismatch",
      ),
    });
  });

  it("rejects an unknown generated field error shape", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.clientTypesPath,
      clientTypesSource.replace(
        "error: TError extends Record<string, unknown>",
        "error: TError",
      ),
    );

    await expect(runPatch(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("Generated field error type mismatch"),
    });
  });
});
