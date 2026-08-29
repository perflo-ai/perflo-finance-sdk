import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const generatorPath = resolve("scripts/generate-auth-policy.mjs");
const temporaryDirectories: Array<string> = [];

function openApiDocument(paths: Record<string, unknown>, security?: unknown) {
  return {
    components: {
      securitySchemes: {
        BearerAuth: { scheme: "bearer", type: "http" },
      },
    },
    paths,
    security,
  };
}

async function runGenerator(document: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "perflo-auth-policy-"));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, "openapi.json");
  const outputPath = join(directory, "generated");
  await mkdir(outputPath);
  await writeFile(inputPath, JSON.stringify(document));

  await execFileAsync(process.execPath, [generatorPath], {
    env: {
      ...process.env,
      PERFLO_SDK_OPENAPI: inputPath,
      PERFLO_SDK_OUTPUT: outputPath,
    },
  });
  return readFile(join(outputPath, "auth-policy.gen.ts"), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("auth policy generator", () => {
  it("implements effective OpenAPI security including anonymous alternatives", async () => {
    const source = await runGenerator(
      openApiDocument(
        {
          "/anonymous": { get: { security: [{}, { BearerAuth: [] }] } },
          "/inherited": { get: {} },
          "/protected": { get: { security: [{ BearerAuth: [] }] } },
        },
        [{ BearerAuth: [] }],
      ),
    );

    expect(source).toContain(
      'authenticated: false,\n    method: "GET",\n    pattern: new RegExp("^/anonymous$"),',
    );
    expect(source).toContain(
      'authenticated: true,\n    method: "GET",\n    pattern: new RegExp("^/inherited$"),',
    );
    expect(source).toContain(
      'authenticated: true,\n    method: "GET",\n    pattern: new RegExp("^/protected$"),',
    );
  });

  it("rejects unsupported security schemes", async () => {
    await expect(
      runGenerator(
        openApiDocument({
          "/protected": { get: { security: [{ ApiKeyAuth: [] }] } },
        }),
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unsupported OpenAPI security scheme"),
    });
  });

  it("rejects a malformed bearer scheme with no authenticated operation", async () => {
    await expect(
      runGenerator({
        components: {
          securitySchemes: { BearerAuth: { type: "apiKey" } },
        },
        paths: { "/anonymous": { get: {} } },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI components.securitySchemes.BearerAuth must be an HTTP bearer scheme",
      ),
    });
  });

  it("rejects path-item references instead of omitting their operations", async () => {
    await expect(
      runGenerator(
        openApiDocument({ "/referenced": { $ref: "#/paths/~1other" } }),
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI path item /referenced uses an unsupported reference; it must be resolved before generation",
      ),
    });
  });

  it("rejects an OpenAPI document with no operations", async () => {
    await expect(runGenerator(openApiDocument({}))).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI document has no operations"),
    });
  });
});
