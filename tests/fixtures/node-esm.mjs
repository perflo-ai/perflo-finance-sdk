import {
  createPerfloClient,
  isDefinitiveNoOperation,
  isSubmissionUncertain,
  listActivity,
  listServices,
  publicConfig,
} from "@perflo/finance-sdk";

const client = createPerfloClient();

if (
  typeof publicConfig !== "function" ||
  typeof listActivity !== "function" ||
  typeof listServices !== "function" ||
  typeof isDefinitiveNoOperation !== "function" ||
  typeof isSubmissionUncertain !== "function" ||
  typeof client.refreshAgentToken !== "function" ||
  client.getConfig().baseUrl !== "https://api-gateway.perflo.ai"
) {
  throw new Error("The built package root is not usable from Node ESM");
}
