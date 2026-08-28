// Internal. Shared structural primitives only; module-specific guards stay with their module.
export type UnknownRecord = Record<PropertyKey, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
