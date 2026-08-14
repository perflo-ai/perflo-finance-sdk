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

interface Fixture {
  directory: string;
  sdkPath: string;
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "perflo-result-contract-"));
  temporaryDirectories.push(directory);
  const generatedDirectory = resolve(directory, "src/generated");
  const sdkPath = resolve(generatedDirectory, "sdk.gen.ts");
  await mkdir(generatedDirectory, { recursive: true });
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
    writeFile(sdkPath, sdkSource),
  ]);
  return { directory, sdkPath };
}

async function runPatch(fixture: Fixture) {
  return execFileAsync(process.execPath, [patchPath], {
    env: {
      ...process.env,
      PERFLO_SDK_RESULT_CONTRACT_ROOT: fixture.directory,
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
  it("forces field results and narrows generated and shared options", async () => {
    const fixture = await createFixture();

    const first = await runPatch(fixture);
    const firstSdk = await readFile(fixture.sdkPath, "utf8");
    const second = await runPatch(fixture);

    expect(first.stdout).toContain(
      "Enforced field-style results for 1 generated operations",
    );
    expect(second.stdout).toContain(
      "Enforced field-style results for 1 generated operations",
    );
    expect(firstSdk).toContain(
      '    ...options,\n    responseStyle: "fields",\n',
    );
    expect(firstSdk).toContain(
      'Omit<Options2<TData, ThrowOnError, TResponse>, "responseStyle">',
    );
    expect(firstSdk).toContain(
      'type GeneratedOperationClient = Omit<Client, "getConfig" | "setConfig">',
    );
    expect(firstSdk).toContain('responseStyle?: "fields";');
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
      stderr: expect.stringContaining(
        "must force responseStyle to fields last",
      ),
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
});
