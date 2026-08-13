import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageDirectory, "dist");

if (
  dirname(outputDirectory) !== packageDirectory ||
  basename(outputDirectory) !== "dist"
) {
  throw new Error("Refusing to clean an unexpected output directory");
}

await rm(outputDirectory, { force: true, recursive: true });
