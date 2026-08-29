import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOpenApiResponseValidator,
  type ResponseValidationInput,
  responseSchemaUri,
} from "../scripts/lib/openapi-response-validator.ts";

const defaultInput: ResponseValidationInput = {
  contentType: "application/json",
  method: "get",
  path: "/widgets",
  status: 200,
  value: { id: "widget-1" },
};

function openApiSource(
  paths: Record<string, unknown>,
  additions: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Response validator fixture", version: "1.0.0" },
    paths,
    ...additions,
  });
}

function response(
  schema: unknown,
  mediaType = "application/json",
): Record<string, unknown> {
  return {
    description: "Fixture response",
    content: { [mediaType]: schema === undefined ? {} : { schema } },
  };
}

function operationResponses(
  responses: Record<string, unknown>,
): Record<string, unknown> {
  return { "/widgets": { get: { responses } } };
}

async function validatorFor(
  responses: Record<string, unknown>,
  additions: Record<string, unknown> = {},
) {
  return createOpenApiResponseValidator(
    openApiSource(operationResponses(responses), additions),
  );
}

describe("responseSchemaUri", () => {
  it("escapes JSON Pointer tokens before URI-encoding the fragment", () => {
    expect(
      responseSchemaUri(
        "https://schemas.example/openapi.json",
        "patch",
        "/charges/{id}~draft?x=%#",
        "2/0~X",
        'Application/Problem+JSON;profile="a b"',
      ),
    ).toBe(
      "https://schemas.example/openapi.json#/paths/~1charges~1%7Bid%7D~0draft%3Fx%3D%25%23/patch/responses/2~10~0X/content/Application~1Problem%2BJSON%3Bprofile%3D%22a%20b%22/schema",
    );
  });
});

describe("createOpenApiResponseValidator", () => {
  it("resolves internal schema references", async () => {
    const validator = await validatorFor(
      {
        "200": response({ $ref: "#/components/schemas/Widget" }),
      },
      {
        components: {
          schemas: {
            Widget: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
        },
      },
    );

    await expect(validator.validateResponse(defaultInput)).resolves.toEqual([]);
    const errors = await validator.validateResponse({
      ...defaultInput,
      value: { id: 12 },
    });
    expect(errors).not.toEqual([]);
    expect(errors.join("\n")).toContain("fails type");
  });

  it("keeps response values out of BASIC validation errors", async () => {
    const validator = await validatorFor({
      "200": response({ type: "integer" }),
    });
    const secret = "do-not-leak-this-response-value";

    const errors = await validator.validateResponse({
      ...defaultInput,
      value: secret,
    });

    expect(errors).not.toEqual([]);
    expect(errors.join("\n")).not.toContain(secret);
  });

  it("matches media types case-insensitively and ignores parameters", async () => {
    const validator = await validatorFor({
      "200": response({ type: "string" }, "Application/JSON"),
    });

    await expect(
      validator.validateResponse({
        ...defaultInput,
        contentType: " APPLICATION/JSON ; Charset=UTF-8 ",
        value: "ok",
      }),
    ).resolves.toEqual([]);
  });

  it("does not treat application/problem+json as application/json", async () => {
    const validator = await validatorFor({
      "200": {
        description: "Fixture response",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ok"],
              properties: { ok: { const: true } },
            },
          },
          "application/problem+json": {
            schema: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
            },
          },
        },
      },
    });

    await expect(
      validator.validateResponse({
        ...defaultInput,
        value: { ok: true },
      }),
    ).resolves.toEqual([]);
    await expect(
      validator.validateResponse({
        ...defaultInput,
        contentType: "application/problem+json",
        value: { ok: true },
      }),
    ).resolves.not.toEqual([]);
  });

  it("prefers a type wildcard over the global media wildcard", async () => {
    const validator = await validatorFor({
      "200": {
        description: "Fixture response",
        content: {
          "application/*": { schema: { type: "string" } },
          "*/*": { schema: { type: "boolean" } },
        },
      },
    });

    await expect(
      validator.validateResponse({
        ...defaultInput,
        contentType: "application/xml",
        value: "application wildcard",
      }),
    ).resolves.toEqual([]);
    await expect(
      validator.validateResponse({
        ...defaultInput,
        contentType: "text/plain",
        value: true,
      }),
    ).resolves.toEqual([]);
  });

  it("selects exact, range, and default responses in precedence order", async () => {
    const validator = await validatorFor({
      "200": response({ const: "exact" }),
      "2XX": response({ const: "range" }),
      default: response({ const: "default" }),
    });

    await expect(
      validator.validateResponse({ ...defaultInput, value: "exact" }),
    ).resolves.toEqual([]);
    await expect(
      validator.validateResponse({
        ...defaultInput,
        status: 201,
        value: "range",
      }),
    ).resolves.toEqual([]);
    await expect(
      validator.validateResponse({
        ...defaultInput,
        status: 418,
        value: "default",
      }),
    ).resolves.toEqual([]);
  });

  it("reports missing contracts and undeclared statuses", async () => {
    const validator = await validatorFor({
      "200": response({ type: "object" }),
    });

    await expect(
      validator.validateResponse({ ...defaultInput, path: "/missing" }),
    ).resolves.toEqual(["no response contract for GET /missing"]);
    await expect(
      validator.validateResponse({ ...defaultInput, method: "post" }),
    ).resolves.toEqual(["no response contract for POST /widgets"]);
    await expect(
      validator.validateResponse({ ...defaultInput, status: 404 }),
    ).resolves.toEqual(["HTTP 404 is not declared"]);
  });

  it("reports absent or undeclared response media types and absent bodies", async () => {
    const validator = await validatorFor({
      "200": response({ type: "object" }),
    });

    await expect(
      validator.validateResponse({ ...defaultInput, contentType: null }),
    ).resolves.toEqual(["Content-Type absent is not declared"]);
    await expect(
      validator.validateResponse({
        ...defaultInput,
        contentType: "text/plain; charset=utf-8",
      }),
    ).resolves.toEqual(["Content-Type text/plain is not declared"]);
    await expect(
      validator.validateResponse({ ...defaultInput, value: undefined }),
    ).resolves.toEqual(["required response body is absent"]);
  });

  it("accepts schema-less content but enforces content-less responses", async () => {
    const schemaLess = await validatorFor({
      "200": response(undefined),
    });
    const contentLess = await validatorFor({
      "200": { description: "No response body" },
    });

    await expect(
      schemaLess.validateResponse({ ...defaultInput, value: { anything: 1 } }),
    ).resolves.toEqual([]);
    await expect(
      contentLess.validateResponse({ ...defaultInput, value: undefined }),
    ).resolves.toEqual([]);
    await expect(
      contentLess.validateResponse({ ...defaultInput, value: null }),
    ).resolves.toEqual([
      "response body is present but the contract declares none",
    ]);
  });

  it("rejects unresolved response-object references at validation time", async () => {
    const validator = await validatorFor(
      {
        "200": { $ref: "#/components/responses/Widget" },
      },
      {
        components: {
          responses: {
            Widget: response({ type: "object" }),
          },
        },
      },
    );

    await expect(validator.validateResponse(defaultInput)).resolves.toEqual([
      "response-object references must be resolved before validation",
    ]);
  });

  it("rejects external references anywhere in the document", async () => {
    const source = openApiSource(
      operationResponses({
        "200": response({
          $ref: "https://schemas.example/widget.json#/$defs/Widget",
        }),
      }),
    );

    await expect(createOpenApiResponseValidator(source)).rejects.toThrow(
      "OpenAPI document contains unsupported external reference https://schemas.example/widget.json#/$defs/Widget",
    );
  });

  it("derives isolated document identities from the exact source", async () => {
    const source = openApiSource({
      "/widgets": {
        get: { responses: { "200": response({ const: "first" }) } },
      },
    });
    const reformattedSource = `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
    const first = await createOpenApiResponseValidator(source);
    const reformatted = await createOpenApiResponseValidator(reformattedSource);

    expect(first.documentSha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(reformatted.documentSha256).toBe(
      createHash("sha256").update(reformattedSource).digest("hex"),
    );
    expect(first.documentSha256).not.toBe(reformatted.documentSha256);
    await expect(
      first.validateResponse({ ...defaultInput, value: "first" }),
    ).resolves.toEqual([]);
    await expect(
      reformatted.validateResponse({ ...defaultInput, value: "first" }),
    ).resolves.toEqual([]);
  });

  it("rejects malformed JSON, missing paths, and invalid OpenAPI", async () => {
    await expect(createOpenApiResponseValidator("{")).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(
      createOpenApiResponseValidator(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Missing paths", version: "1.0.0" },
        }),
      ),
    ).rejects.toThrow("OpenAPI document must contain paths");
    await expect(
      createOpenApiResponseValidator(
        openApiSource({
          "/widgets": { get: { responses: { "200": { content: {} } } } },
        }),
      ),
    ).rejects.toThrow("OpenAPI document is invalid:");
  });
});
