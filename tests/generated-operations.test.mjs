// This test stays .mjs so importing the .mjs library does not require allowJs or a declaration file.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@hey-api/openapi-ts";
import { afterEach, describe, expect, it } from "vitest";
import generatorConfig from "../openapi-ts.config.ts";
import {
  extractOpenApiOperations,
  extractOperationTypes,
  extractSdkOperations,
} from "../scripts/generate-sdk-reference.mjs";
import { discoverOperations } from "../scripts/lib/generated-operations.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function operation(name, clientTypes = "Responses, Errors, ThrowOnError") {
  return `export const ${name} = <ThrowOnError extends boolean = false>(
  options: Options<Data, ThrowOnError>,
): RequestResult<Responses, Errors, ThrowOnError> =>
  options.client.get<${clientTypes}>({
    url: "/items",
    ...options,
  });`;
}

describe("generated operation discovery", () => {
  it("rejects invalid TypeScript with the source filename", () => {
    expect(() =>
      discoverOperations("fixture.ts", "export const invalid = ("),
    ).toThrow("Invalid TypeScript in fixture.ts:");
  });

  it("rejects duplicate generated routes", () => {
    expect(() =>
      discoverOperations(
        "fixture.ts",
        `${operation("first")}\n\n${operation("second")}`,
      ),
    ).toThrow("Duplicate generated operation GET /items");
  });

  it.each([
    [
      "client type-argument arity",
      "Responses, Errors",
      "client call must have three type arguments",
    ],
    [
      "client ThrowOnError position type",
      "Responses, Errors, boolean",
      "has an invalid client ThrowOnError type",
    ],
  ])("rejects invalid %s", (_name, clientTypes, message) => {
    expect(() =>
      discoverOperations("fixture.ts", operation("invalid", clientTypes)),
    ).toThrow(`Generated operation invalid ${message}`);
  });

  it("rejects an operation-shaped arrow with a block body", () => {
    const blockBody = `export const invalid = <ThrowOnError extends boolean = false>(
  options: Options<Data, ThrowOnError>,
): RequestResult<Responses, Errors, ThrowOnError> => {
  return options.client.get<Responses, Errors, ThrowOnError>({
    url: "/items",
    ...options,
  });
};`;

    expect(() => discoverOperations("fixture.ts", blockBody)).toThrow(
      "Generated operation invalid must have an expression-bodied call",
    );
  });

  it("rejects a generated operation that does not call a client method", () => {
    const source = operation("invalid").replace(
      "options.client.get",
      "options.get",
    );

    expect(() => discoverOperations("fixture.ts", source)).toThrow(
      "Generated operation invalid must call options.client.<method>",
    );
  });

  it("rejects a generated operation without one object literal argument", () => {
    const source = operation("invalid").replace(
      `({
    url: "/items",
    ...options,
  })`,
      "(options)",
    );

    expect(() => discoverOperations("fixture.ts", source)).toThrow(
      "Generated operation invalid must pass one object literal argument",
    );
  });

  it("rejects a generated operation without one string-literal URL", () => {
    const source = operation("invalid").replace(
      'url: "/items"',
      "url: options.url",
    );

    expect(() => discoverOperations("fixture.ts", source)).toThrow(
      "Generated operation invalid must contain one string-literal URL",
    );
  });
});

function operationTypes(overrides = "") {
  return `export type Data = {
  body?: never;
  path?: never;
  query?: never;
  url: "/items";
};
export type Responses = { 200: string };
export type Response = Responses[keyof Responses];
${overrides}
export type Errors = { 400: string };
export type ErrorResponse = Errors[keyof Errors];`;
}

function operationTypeFixture() {
  return {
    dataType: "Data",
    errorsType: "Errors",
    functionName: "getItems",
    hasSuccessResponse: true,
    path: "/items",
    responsesType: "Responses",
  };
}

describe("generated definition sibling discovery", () => {
  it.each([
    ["no", "", 0],
    [
      "multiple",
      "export type AlternateResponse = Responses[keyof Responses];",
      2,
    ],
  ])("rejects %s structural response matches", (_name, override, count) => {
    const types =
      count === 0
        ? operationTypes().replace(
            "export type Response = Responses[keyof Responses];\n",
            "",
          )
        : operationTypes(override);

    expect(() =>
      extractOperationTypes("fixture-types.ts", types, [
        operationTypeFixture(),
      ]),
    ).toThrow(
      new TypeError(
        `fixture-types.ts: expected exactly one exported alias for Responses[keyof Responses], found ${count}`,
      ),
    );
  });
});

function adversarialDocument() {
  const identifiers = [
    "create_a_b_test",
    "get_b_2_b",
    "export_p_l",
    "list_i_o_devices",
    "health",
  ];
  const paths = Object.fromEntries(
    identifiers.map((operationId, index) => [
      `/proof/${index}`,
      {
        get: {
          operationId,
          responses: {
            200: {
              content: {
                "application/json": { schema: { type: "string" } },
              },
              description: "Success",
            },
            400: {
              content: {
                "application/json": { schema: { type: "string" } },
              },
              description: "Error",
            },
          },
          security: [],
          summary: operationId,
          tags: ["Proof"],
        },
      },
    ]),
  );
  return {
    components: {
      securitySchemes: {
        BearerAuth: { scheme: "bearer", type: "http" },
      },
    },
    info: { title: "Generator naming proof", version: "1.0.0" },
    openapi: "3.1.0",
    paths,
    tags: [{ name: "Proof" }],
  };
}

describe("pinned generator naming differential", () => {
  it("matches every asserted or located operation name to emitted artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perflo-naming-proof-"));
    temporaryDirectories.push(directory);
    const document = adversarialDocument();
    const openApiPath = resolve(directory, "openapi.json");
    const outputPath = resolve(directory, "generated");
    await writeFile(openApiPath, JSON.stringify(document));
    const config = await generatorConfig;
    await createClient({
      ...config,
      input: openApiPath,
      logs: "silent",
      output: { ...config.output, path: outputPath },
    });

    const sdkFilename = resolve(outputPath, "sdk.gen.ts");
    const typesFilename = resolve(outputPath, "types.gen.ts");
    const [sdkSource, typesSource] = await Promise.all([
      readFile(sdkFilename, "utf8"),
      readFile(typesFilename, "utf8"),
    ]);
    const openApi = extractOpenApiOperations(document);
    const sdkOperations = extractSdkOperations(
      sdkFilename,
      sdkSource,
      openApi.operations,
    );
    const sdkByRoute = new Map(
      sdkOperations.map((operation) => [operation.key, operation]),
    );
    const differences = [];
    const operations = openApi.operations.map((operation) => {
      const sdkOperation = sdkByRoute.get(operation.key);
      const expectedFunction = openApi.operationNames.get(
        operation.operationId,
      );
      if (sdkOperation.functionName !== expectedFunction) {
        differences.push(
          `${operation.operationId}: expected function ${expectedFunction}, emitted ${sdkOperation.functionName}`,
        );
      }
      return { ...operation, ...sdkOperation };
    });
    extractOperationTypes(typesFilename, typesSource, operations);

    const emittedFunctionNames = new Set(
      [...discoverOperations(sdkFilename, sdkSource).values()].map(
        (operation) => operation.name,
      ),
    );
    const emittedTypeNames = new Set(
      [...typesSource.matchAll(/^export type (\S+) =/gmu)].map(
        (match) => match[1],
      ),
    );
    const consumedTypeNames = new Set();
    for (const operation of operations) {
      if (!emittedFunctionNames.has(operation.functionName)) {
        differences.push(`missing function ${operation.functionName}`);
      }
      for (const [role, name] of [
        ["data", operation.dataType],
        ["errors", operation.errorsType],
        ["error", operation.errorType],
        ["responses", operation.responsesType],
        ["response", operation.responseType],
      ]) {
        consumedTypeNames.add(name);
        if (!emittedTypeNames.has(name)) {
          differences.push(`missing ${role} type ${name}`);
        }
      }
    }

    const sdkExportLines = sdkSource
      .split("\n")
      .filter((line) => /^export const /u.test(line));
    const typeExportLines = typesSource.split("\n").filter((line) => {
      const name = line.match(/^export type (\S+) =/u)?.[1];
      return name !== undefined && consumedTypeNames.has(name);
    });
    console.info(
      `Generator differential divergent count: ${differences.length}`,
    );
    console.info(`sdk.gen.ts:\n${sdkExportLines.join("\n")}`);
    console.info(`types.gen.ts:\n${typeExportLines.join("\n")}`);

    expect(differences).toEqual([]);
  });
});
