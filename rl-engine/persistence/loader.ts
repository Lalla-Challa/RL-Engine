/**
 * Persistence loader — spec §29 (outside simulation kernel)
 * Pure: storage → spec → environment object.
 */

import type { EnvironmentSpecification } from "../core/types";
import { readFileSync, existsSync } from "node:fs";

export function loadSpecFromFile(path: string): EnvironmentSpecification {
  if (!existsSync(path)) throw new Error(`spec file not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as EnvironmentSpecification;
}

export function loadSpecFromObject(obj: unknown): EnvironmentSpecification {
  return obj as EnvironmentSpecification;
}
