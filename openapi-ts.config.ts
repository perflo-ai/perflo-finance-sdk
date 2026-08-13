import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi.json",
  output: {
    path: process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
    clean: true,
    module: {
      extension: ".js",
    },
    postProcess: ["biome:format"],
    source: false,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      enums: false,
    },
    {
      name: "@hey-api/client-fetch",
      bundle: true,
      throwOnError: false,
    },
    {
      name: "@hey-api/sdk",
      auth: true,
      client: false,
      operations: "flat",
      paramsStructure: "grouped",
      responseStyle: "fields",
      transformer: false,
      validator: false,
    },
  ],
});
