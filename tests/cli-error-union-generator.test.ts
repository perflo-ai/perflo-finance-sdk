import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageDirectory = resolve(import.meta.dirname, "..");
const patchPath = resolve(
  packageDirectory,
  "scripts/patch-cli-error-unions.mjs",
);
const temporaryDirectories: Array<string> = [];
const errorTypes = [
  "DevicesErrors",
  "PollDeviceErrors",
  "PollSignErrors",
  "RefreshTokenErrors",
  "RevokeTokenErrors",
  "StartDeviceErrors",
  "StartSignErrors",
];

function errorDeclaration(typeName: string) {
  return `export type ${typeName} = {
  401: CliErrorResponse;
  default: CliErrorResponse;
};`;
}

async function createFixture(transform: (source: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), "perflo-cli-error-union-"));
  temporaryDirectories.push(directory);
  const outputDirectory = resolve(directory, "generated");
  const typesPath = resolve(outputDirectory, "types.gen.ts");
  await mkdir(outputDirectory);
  await writeFile(
    typesPath,
    transform(errorTypes.map(errorDeclaration).join("\n\n")),
  );
  return outputDirectory;
}

async function runPatch(outputDirectory: string) {
  return execFileAsync(process.execPath, [patchPath], {
    env: {
      ...process.env,
      PERFLO_SDK_OUTPUT: outputDirectory,
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

describe("CLI error union patch", () => {
  it("rejects a partially widened property in a known declaration", async () => {
    const outputDirectory = await createFixture((source) =>
      source.replace(
        "  401: CliErrorResponse;",
        "  401: CliErrorResponse | ValidationError;",
      ),
    );

    await expect(runPatch(outputDirectory)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated DevicesErrors CLI error responses missing ProblemDetails: 401",
      ),
    });
  });

  it("rejects an unknown declaration with a partial CLI union", async () => {
    const outputDirectory = await createFixture(
      (source) => `${source}

export type UnknownErrors = {
  401: CliErrorResponse | ValidationError;
};`,
    );

    await expect(runPatch(outputDirectory)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Unexpected generated CLI error declaration UnknownErrors",
      ),
    });
  });
});
