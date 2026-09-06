/**
 * Reward compiler — spec §18–19 + §32
 */

import type { RewardDef } from "../core/types";

export type RewardCompileError = { code: string; message: string };

export function compileReward(def: RewardDef, stateFields: string[]): RewardCompileError[] {
  const errors: RewardCompileError[] = [];
  for (const c of def?.components ?? []) {
    if (!c.id) errors.push({ code: "invalid_reward", message: "reward component id is required" });
    if (typeof c.weight !== "number") errors.push({ code: "invalid_reward", message: `reward ${c.id}: weight must be number` });
    if (!c.expression) errors.push({ code: "invalid_reward", message: `reward ${c.id}: expression is required` });
  }
  return errors;
}
