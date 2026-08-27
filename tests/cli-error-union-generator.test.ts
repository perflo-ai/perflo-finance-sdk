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
  "scripts/patch-cli-error-unions.mjs",
);
const temporaryDirectories: Array<string> = [];
const cliOperations = [
  ["devices", "DevicesErrors"],
  ["poll_device", "PollDeviceErrors"],
  ["poll_sign", "PollSignErrors"],
  ["refresh_token", "RefreshTokenErrors"],
  ["revoke_token", "RevokeTokenErrors"],
  ["start_device", "StartDeviceErrors"],
  ["start_sign", "StartSignErrors"],
] as const;

function response(primary: string) {
  return {
    description: "fixture",
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${primary}` },
      },
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetails" },
      },
    },
  };
}

function fixtureOpenapi() {
  return {
    openapi: "3.1.0",
    info: { title: "fixture", version: "1" },
    paths: {
      ...Object.fromEntries(
        cliOperations.map(([operationId], index) => [
          `/cli/${index}`,
          {
            get: {
              operationId,
              responses: { 401: response("CliErrorResponse") },
            },
          },
        ]),
      ),
      "/v1/capabilities/{slug}": {
        get: {
          operationId: "agent_get_capability",
          responses: { 404: response("AgentModeError") },
        },
      },
    },
  };
}

function fixtureTypes() {
  return [
    ...cliOperations.map(
      ([, typeName]) => `export type ${typeName} = {
  401: CliErrorResponse;
  404: AgentModeError;
};`,
    ),
    `export type AgentGetCapabilityErrors = {
  404: AgentModeError;
};`,
    `export type UnaffectedErrors = {
  404: AgentModeError;
};`,
  ].join("\n\n");
}

async function createFixture(
  transform: (source: string) => string = (source) => source,
) {
  const directory = await mkdtemp(join(tmpdir(), "perflo-error-union-"));
  temporaryDirectories.push(directory);
  const outputDirectory = resolve(directory, "generated");
  const typesPath = resolve(outputDirectory, "types.gen.ts");
  const openapiPath = resolve(directory, "openapi.json");
  await mkdir(outputDirectory);
  await writeFile(typesPath, transform(fixtureTypes()));
  await writeFile(openapiPath, JSON.stringify(fixtureOpenapi()));
  return { openapiPath, outputDirectory, typesPath };
}

async function runPatch(outputDirectory: string, openapiPath: string) {
  return execFileAsync(process.execPath, [patchPath], {
    env: {
      ...process.env,
      PERFLO_SDK_OPENAPI: openapiPath,
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

describe("mixed-content error union patch", () => {
  it("widens only the exact declarations and statuses published with multiple media types", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture();

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    for (const [, typeName] of cliOperations) {
      expect(source).toContain(`export type ${typeName} = {
  401: CliErrorResponse | ProblemDetails;
  404: AgentModeError;
};`);
    }
    expect(source).toContain(`export type AgentGetCapabilityErrors = {
  404: AgentModeError | ProblemDetails;
};`);
    expect(source).toContain(`export type UnaffectedErrors = {
  404: AgentModeError;
};`);
  });

  it("rejects a missing generated declaration", async () => {
    const fixture = await createFixture((source) =>
      source.replace(
        /export type AgentGetCapabilityErrors = \{[\s\S]*?\n\};\n\n/,
        "",
      ),
    );

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Missing generated AgentGetCapabilityErrors declaration",
      ),
    });
  });

  it("rejects an unexpected generated type at a mapped status", async () => {
    const fixture = await createFixture((source) =>
      source.replace(
        "export type AgentGetCapabilityErrors = {\n  404: AgentModeError;",
        "export type AgentGetCapabilityErrors = {\n  404: ValidationError;",
      ),
    );

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated AgentGetCapabilityErrors status 404 has unexpected type ValidationError",
      ),
    });
  });
});
