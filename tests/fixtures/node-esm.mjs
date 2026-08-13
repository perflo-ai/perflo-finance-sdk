import { createPerfloClient, publicConfig } from "@perflo/finance-sdk";

const client = createPerfloClient();

if (
  typeof publicConfig !== "function" ||
  client.getConfig().baseUrl !== "https://api-gateway.perflo.ai"
) {
  throw new Error("The built package root is not usable from Node ESM");
}
