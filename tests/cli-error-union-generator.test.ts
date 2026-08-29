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
const openapiTsUrl = import.meta.resolve("@hey-api/openapi-ts");
const temporaryDirectories: Array<string> = [];
const httpMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);
const cliOperations = [
  ["devices", "DevicesErrors", "devices"],
  ["poll_device", "PollDeviceErrors", "pollDevice"],
  ["poll_sign", "PollSignErrors", "pollSign"],
  ["refresh_token", "RefreshTokenErrors", "refreshToken"],
  ["revoke_token", "RevokeTokenErrors", "revokeToken"],
  ["start_device", "StartDeviceErrors", "startDevice"],
  ["start_sign", "StartSignErrors", "startSign"],
] as const;

function mixedMediaResponse(primary: string, secondary = "ProblemDetails") {
  return {
    description: "fixture",
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${primary}` },
      },
      "application/problem+json": {
        schema: { $ref: `#/components/schemas/${secondary}` },
      },
    },
  };
}

function singleMediaResponse(primary: string) {
  return {
    description: "fixture",
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${primary}` },
      },
    },
  };
}

function document<
  Paths extends Record<string, Record<string, unknown>>,
  Schemas extends Record<string, unknown>,
>(paths: Paths, schemas: Schemas) {
  return {
    openapi: "3.1.0",
    info: { title: "fixture", version: "1" },
    paths,
    components: { schemas },
  };
}

function fixtureOpenapi() {
  return document(
    {
      ...Object.fromEntries(
        cliOperations.map(([operationId], index) => [
          `/cli/${index}`,
          {
            get: {
              operationId,
              responses: { 401: mixedMediaResponse("CliErrorResponse") },
            },
          },
        ]),
      ),
      "/v1/capabilities/{slug}": {
        get: {
          operationId: "pay_per_use_get_capability",
          responses: { 404: mixedMediaResponse("PayPerUseError") },
        },
      },
    },
    {
      CliErrorResponse: {},
      PayPerUseError: {},
      ProblemDetails: {},
      SuccessResponse: {},
    },
  );
}

function fixtureOpenapiWithMixedStatuses(
  successResponse = singleMediaResponse("SuccessResponse"),
) {
  const openapi = fixtureOpenapi();
  return {
    ...openapi,
    paths: {
      ...openapi.paths,
      "/mixed-statuses": {
        get: {
          operationId: "mixed_statuses",
          responses: {
            200: successResponse,
            404: mixedMediaResponse("PayPerUseError"),
            "4XX": mixedMediaResponse("PayPerUseError"),
          },
        },
      },
    },
  };
}

function fixtureOpenapiWithNonCanonicalNames() {
  return document(
    {
      "/non-canonical": {
        get: {
          operationId: "getURL",
          responses: {
            404: mixedMediaResponse("url_response", "problem_details"),
          },
        },
      },
    },
    { problem_details: {}, url_response: {} },
  );
}

function fixtureOpenapiWithLeadingDigit() {
  return document(
    {
      "/leading-digit": {
        get: {
          operationId: "123getURL",
          responses: { 404: mixedMediaResponse("url_response") },
        },
      },
    },
    { ProblemDetails: {}, url_response: {} },
  );
}

function fixtureOpenapiWithCollidingOperationIds() {
  const openapi = fixtureOpenapi();
  return {
    ...openapi,
    paths: {
      ...openapi.paths,
      "/collision-a": {
        get: {
          operationId: "collision_id",
          responses: { 404: mixedMediaResponse("PayPerUseError") },
        },
      },
      "/collision-b": {
        get: {
          operationId: "collision-id",
          responses: { 404: mixedMediaResponse("CliErrorResponse") },
        },
      },
    },
  };
}

function fixtureOpenapiWithSchemas(...names: Array<string>) {
  const openapi = fixtureOpenapi();
  return {
    ...openapi,
    components: {
      schemas: {
        ...openapi.components.schemas,
        ...Object.fromEntries(names.map((name) => [name, {}])),
      },
    },
  };
}

function fixtureOpenapiWithReferencedResponse() {
  const openapi = fixtureOpenapi();
  return {
    ...openapi,
    paths: {
      ...openapi.paths,
      "/v1/capabilities/{slug}": {
        get: {
          operationId: "pay_per_use_get_capability",
          responses: {
            404: { $ref: "#/components/responses/MixedError" },
          },
        },
      },
    },
    components: {
      ...openapi.components,
      responses: {
        MixedError: mixedMediaResponse("PayPerUseError"),
      },
    },
  };
}

function fixtureOpenapiWithReferencedPathItem() {
  const openapi = fixtureOpenapi();
  return {
    ...openapi,
    paths: {
      ...openapi.paths,
      "/referenced": { $ref: "#/components/pathItems/Referenced" },
    },
  };
}

function fixtureOpenapiWithSuccessOnlyOperation() {
  return document(
    {
      "/success-only": {
        get: {
          operationId: "success_only",
          responses: { 200: singleMediaResponse("SuccessResponse") },
        },
      },
    },
    { SuccessResponse: {} },
  );
}

function fixtureTypes() {
  return [
    ...cliOperations.map(
      ([, typeName]) => `export type ${typeName} = {
  401: CliErrorResponse;
  404: PayPerUseError;
};`,
    ),
    `export type PayPerUseGetCapabilityErrors = {
  404: PayPerUseError;
};`,
    `export type MixedStatusesErrors = {
  404: PayPerUseError;
  "4XX": PayPerUseError;
};`,
    `export type MixedStatusesResponses = {
  200: SuccessResponse;
};`,
    `export type GetUrlErrors = {
  404: UrlResponse;
};`,
    `export type CollisionIdErrors = {
  404: PayPerUseError;
};`,
    `export type CollisionId2Errors = {
  404: CliErrorResponse;
};`,
    `export type UnaffectedErrors = {
  404: PayPerUseError;
};`,
  ].join("\n\n");
}

const generatedOperations = new Map([
  ...cliOperations.map(
    ([, errorsType, name], index) =>
      [`GET /cli/${index}`, { errorsType, name }] as const,
  ),
  [
    "GET /v1/capabilities/{slug}",
    {
      errorsType: "PayPerUseGetCapabilityErrors",
      name: "payPerUseGetCapability",
    },
  ],
  [
    "GET /mixed-statuses",
    { errorsType: "MixedStatusesErrors", name: "mixedStatuses" },
  ],
  ["GET /non-canonical", { errorsType: "GetUrlErrors", name: "getUrl" }],
  ["GET /leading-digit", { errorsType: "GetUrlErrors", name: "_123GetUrl" }],
  [
    "GET /collision-a",
    { errorsType: "CollisionIdErrors", name: "collisionId" },
  ],
  [
    "GET /collision-b",
    { errorsType: "CollisionId2Errors", name: "collisionId2" },
  ],
  ["GET /success-only", { errorsType: "unknown", name: "successOnly" }],
]);

function fixtureSdk(openapi: {
  paths: Record<string, Record<string, unknown>>;
}) {
  const declarations = [];
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (!httpMethods.has(method)) {
        continue;
      }
      const route = `${method.toUpperCase()} ${path}`;
      const operation = generatedOperations.get(route);
      if (operation === undefined) {
        throw new Error(`Missing fixture SDK operation ${route}`);
      }
      declarations.push(`export const ${operation.name} = <ThrowOnError extends boolean = false>(
  options: Options<unknown, ThrowOnError>,
): RequestResult<unknown, ${operation.errorsType}, ThrowOnError> =>
  options.client.${method}<unknown, ${operation.errorsType}, ThrowOnError>({
    url: ${JSON.stringify(path)},
    ...options,
  });`);
    }
  }
  return declarations.join("\n\n");
}

async function createFixture({
  transformSdk = (source: string) => source,
  transformTypes = (source: string) => source,
  openapi = fixtureOpenapi(),
}: {
  transformSdk?: (source: string) => string;
  transformTypes?: (source: string) => string;
  openapi?: {
    components?: {
      responses?: Record<string, unknown>;
      schemas?: Record<string, unknown>;
    };
    paths: Record<string, Record<string, unknown>>;
  };
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "perflo-error-union-"));
  temporaryDirectories.push(directory);
  const outputDirectory = resolve(directory, "generated");
  const sdkPath = resolve(outputDirectory, "sdk.gen.ts");
  const typesPath = resolve(outputDirectory, "types.gen.ts");
  const openapiPath = resolve(directory, "openapi.json");
  await mkdir(outputDirectory);
  await writeFile(typesPath, transformTypes(fixtureTypes()));
  await writeFile(sdkPath, transformSdk(fixtureSdk(openapi)));
  await writeFile(openapiPath, JSON.stringify(openapi));
  return { openapiPath, outputDirectory, typesPath };
}

async function mutateOpenApi(
  fixture: { openapiPath: string },
  mutate: (document: ReturnType<typeof JSON.parse>) => void,
) {
  const document = JSON.parse(await readFile(fixture.openapiPath, "utf8"));
  mutate(document);
  await writeFile(fixture.openapiPath, JSON.stringify(document));
}

async function runPatch(
  outputDirectory: string,
  openapiPath: string,
  reservedTypeNames: Array<string> = [],
) {
  const preload = `import { reserved } from ${JSON.stringify(openapiTsUrl)}; reserved.type.set((previous) => [...previous, ...${JSON.stringify(reservedTypeNames)}]);`;
  const args =
    reservedTypeNames.length === 0
      ? [patchPath]
      : [
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
          patchPath,
        ];
  return execFileAsync(process.execPath, args, {
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
  it("widens mixed-content errors while leaving the generated success type unchanged", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture({
      openapi: fixtureOpenapiWithMixedStatuses(),
    });

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    expect(source).toContain(`export type MixedStatusesErrors = {
  404: PayPerUseError | ProblemDetails;
  "4XX": PayPerUseError | ProblemDetails;
};`);
    expect(source).toContain(`export type MixedStatusesResponses = {
  200: SuccessResponse;
};`);
  });

  it("discovers the declaration by route and applies the cascaded PascalCase definition profile to schema names", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture({
      openapi: fixtureOpenapiWithNonCanonicalNames(),
    });

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    expect(source).toContain(`export type GetUrlErrors = {
  404: UrlResponse | ProblemDetails;
};`);
  });

  it("accepts and names a dotted component schema key", async () => {
    const openapi = document(
      {
        "/non-canonical": {
          get: {
            operationId: "getURL",
            responses: {
              404: mixedMediaResponse("app.models.User", "problem_details"),
            },
          },
        },
      },
      { "app.models.User": {}, problem_details: {} },
    );
    const { openapiPath, outputDirectory, typesPath } = await createFixture({
      openapi,
      transformTypes: (source) =>
        source.replace("  404: UrlResponse;", "  404: AppModelsUser;"),
    });

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    expect(source).toContain(`export type GetUrlErrors = {
  404: AppModelsUser | ProblemDetails;
};`);
  });

  it("rejects a slash-bearing component schema key", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSchemas("/aA"),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Invalid OpenAPI component schema key "/aA"; keys must match ^[a-zA-Z0-9._-]+$',
      ),
    });
  });

  it("discovers a declaration whose operationId starts with a digit", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture({
      openapi: fixtureOpenapiWithLeadingDigit(),
    });

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    expect(source).toContain(`export type GetUrlErrors = {
  404: UrlResponse | ProblemDetails;
};`);
  });

  it("discovers collision-suffixed declarations by route", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture({
      openapi: fixtureOpenapiWithCollidingOperationIds(),
    });

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    expect(source).toContain(`export type CollisionIdErrors = {
  404: PayPerUseError | ProblemDetails;
};`);
    expect(source).toContain(`export type CollisionId2Errors = {
  404: CliErrorResponse | ProblemDetails;
};`);
  });

  it("rejects component schema names that collide document-wide", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSchemas("url_response", "URLResponse"),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Component schemas url_response and URLResponse both generate UrlResponse",
      ),
    });
  });

  it("rejects a component schema name the generator sanitizes", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSchemas("123Foo"),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Component schema 123Foo generates 123Foo, which the generator sanitizes",
      ),
    });
  });

  it("rejects a non-ASCII component schema key", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSchemas("𐐀Foo"),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Invalid OpenAPI component schema key "𐐀Foo"; keys must match ^[a-zA-Z0-9._-]+$',
      ),
    });
  });

  it("rejects a component schema name the generator reserves", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSchemas("Error"),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath, ["Error"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Component schema Error generates Error, which the generator reserves and would suffix",
      ),
    });
  });

  it("rejects an empty derived secondary media schema name", async () => {
    const openapi = fixtureOpenapiWithSchemas("_");
    openapi.paths["/v1/capabilities/{slug}"].get.responses[404] =
      mixedMediaResponse("PayPerUseError", "_");
    const fixture = await createFixture({ openapi });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Component schema _ generates an empty name, which the generator replaces with _",
      ),
    });
  });

  it("rejects an unrecognized path-item key", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/cli/0"].query = { operationId: "missing" };
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Unsupported OpenAPI path item key "query" for /cli/0',
      ),
    });
  });

  it("rejects a non-object path item with its path", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/cli/0"] = null;
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid OpenAPI path item: /cli/0"),
    });
  });

  it("rejects a defined non-object Paths Object", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths = [];
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI paths must be an object"),
    });
  });

  it("rejects a non-object operation with its route", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/cli/0"].get = null;
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid OpenAPI operation: GET /cli/0"),
    });
  });

  it("accepts supported path-item metadata and extensions", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      Object.assign(document.paths["/cli/0"], {
        summary: "CLI operation",
        parameters: [],
        "x-fixture": { source: "test" },
      });
    });

    const result = await runPatch(fixture.outputDirectory, fixture.openapiPath);

    expect(result.stdout).toContain("Widened 8 generated error declarations");
  });

  it("skips a scalar Paths Object extension", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["x-fixture"] = "fixture";
    });

    const result = await runPatch(fixture.outputDirectory, fixture.openapiPath);

    expect(result.stdout).toContain("Widened 8 generated error declarations");
  });

  it("skips an object-valued Paths Object extension containing get", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["x-fixture"] = {
        get: {
          responses: { 404: mixedMediaResponse("PayPerUseError") },
        },
      };
    });

    const result = await runPatch(fixture.outputDirectory, fixture.openapiPath);

    expect(result.stdout).toContain("Widened 8 generated error declarations");
  });

  it("rejects a non-extension Paths Object key without a leading slash", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths.fixture = { get: {} };
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid OpenAPI path: fixture"),
    });
  });

  it("rejects a referenced response before generation", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithReferencedResponse(),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "GET /v1/capabilities/{slug} 404 uses an unsupported response reference; it must be resolved before generation",
      ),
    });
  });

  it("rejects a non-object response with its route and status", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/cli/0"].get.responses[401] = null;
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Invalid OpenAPI response: GET /cli/0 401",
      ),
    });
  });

  it("rejects a referenced path item beside inline operations", async () => {
    const referencedOperation = `export const referenced = <ThrowOnError extends boolean = false>(
  options: Options<unknown, ThrowOnError>,
): RequestResult<unknown, PayPerUseGetCapabilityErrors, ThrowOnError> =>
  options.client.get<unknown, PayPerUseGetCapabilityErrors, ThrowOnError>({
    url: "/referenced",
    ...options,
  });`;
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithReferencedPathItem(),
      transformSdk: (source) => `${source}\n\n${referencedOperation}`,
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "OpenAPI path item /referenced uses an unsupported reference; it must be resolved before generation",
      ),
    });
  });

  it("distinguishes a generated operation without a named error type", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithNonCanonicalNames(),
      transformSdk: (source) =>
        source.replace(
          "options.client.get<unknown, GetUrlErrors, ThrowOnError>",
          "options.client.get<unknown, unknown, ThrowOnError>",
        ),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "sdk.gen.ts generated operation for GET /non-canonical has no named error type",
      ),
    });
  });

  it("rejects a mixed-content operation missing from sdk.gen.ts", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/missing-operation"] = {
        get: {
          responses: { 404: mixedMediaResponse("PayPerUseError") },
        },
      };
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "sdk.gen.ts has no generated operation for GET /missing-operation",
      ),
    });
  });

  it("rejects a mixed-content response referencing a missing schema", async () => {
    const fixture = await createFixture();
    await mutateOpenApi(fixture, (document) => {
      document.paths["/v1/capabilities/{slug}"].get.responses[404] =
        mixedMediaResponse("PayPerUseError", "MissingSchema");
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "GET /v1/capabilities/{slug} 404 references missing component schema MissingSchema",
      ),
    });
  });

  it("skips a success-only operation whose generated error type is unknown", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithSuccessOnlyOperation(),
      transformTypes: () => "export type SuccessResponse = unknown;\n",
    });
    const before = await readFile(fixture.typesPath, "utf8");

    const result = await runPatch(fixture.outputDirectory, fixture.openapiPath);

    await expect(readFile(fixture.typesPath, "utf8")).resolves.toBe(before);
    expect(result.stdout).toContain("Widened 0 generated error declarations");
  });

  it("rejects an OpenAPI document with no operations", async () => {
    const fixture = await createFixture({
      openapi: { components: { schemas: {} }, paths: {} },
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenAPI document has no operations"),
    });
  });

  it("rejects mixed-content non-error responses", async () => {
    const fixture = await createFixture({
      openapi: fixtureOpenapiWithMixedStatuses(
        mixedMediaResponse("SuccessResponse"),
      ),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "GET /mixed-statuses 200 publishes more than one media type on a non-error status; " +
          "generated types keep at most the first media type when they keep the status " +
          "at all — extend the patch before shipping this contract",
      ),
    });
  });

  it("widens only the exact declarations and statuses published with multiple media types", async () => {
    const { openapiPath, outputDirectory, typesPath } = await createFixture();

    await runPatch(outputDirectory, openapiPath);

    const source = await readFile(typesPath, "utf8");
    for (const [, typeName] of cliOperations) {
      expect(source).toContain(`export type ${typeName} = {
  401: CliErrorResponse | ProblemDetails;
  404: PayPerUseError;
};`);
    }
    expect(source).toContain(`export type PayPerUseGetCapabilityErrors = {
  404: PayPerUseError | ProblemDetails;
};`);
    expect(source).toContain(`export type UnaffectedErrors = {
  404: PayPerUseError;
};`);
  });

  it("rejects a missing generated declaration", async () => {
    const fixture = await createFixture({
      transformTypes: (source) =>
        source.replace(
          /export type PayPerUseGetCapabilityErrors = \{[\s\S]*?\n\};\n\n/,
          "",
        ),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Missing generated PayPerUseGetCapabilityErrors declaration",
      ),
    });
  });

  it("rejects an unexpected generated type at a mapped status", async () => {
    const fixture = await createFixture({
      transformTypes: (source) =>
        source.replace(
          "export type PayPerUseGetCapabilityErrors = {\n  404: PayPerUseError;",
          "export type PayPerUseGetCapabilityErrors = {\n  404: ValidationError;",
        ),
    });

    await expect(
      runPatch(fixture.outputDirectory, fixture.openapiPath),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Generated PayPerUseGetCapabilityErrors status 404 has unexpected type ValidationError",
      ),
    });
  });
});
