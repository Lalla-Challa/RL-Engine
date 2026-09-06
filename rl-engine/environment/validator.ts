/**
 * Environment Validator — spec §33
 * Checks: state, action, transition, reward, observation, termination validity.
 */

import type { EnvironmentSpecification } from "../core/types";
import type { CompilerError } from "./compiler";

export function validateEnvironment(spec: EnvironmentSpecification): { valid: boolean; errors: CompilerError[] } {
  const errors: CompilerError[] = [];

  if (!spec.state || Object.keys(spec.state).length === 0) {
    errors.push({ code: "state_validity", message: "state must define at least one variable" });
  }

  for (const a of spec.actions ?? []) {
    if (!a.kind) errors.push({ code: "action_validity", message: "action definition missing kind" });
  }

  for (const rule of spec.rules ?? []) {
    const outcomes = (rule as unknown as { outcomes?: unknown[] }).outcomes;
    const hasEffects = Array.isArray(rule.effects) && rule.effects.length > 0;
    const hasOutcomes = Array.isArray(outcomes) && outcomes.length > 0;
    if (!hasEffects && !hasOutcomes) {
      // A rule may express its transition purely through stochastic outcomes
      // (spec §14); only rules with NEITHER representation are empty.
      errors.push({ code: "transition_validity", message: `rule ${rule.id}: no effects and no outcomes` });
    }
  }

  for (const rc of spec.rewards?.components ?? []) {
    if (!rc.expression) errors.push({ code: "reward_validity", message: `reward ${rc.id}: expression is required` });
  }

  for (const obs of spec.observations?.fields ?? []) {
    if (!obs.source) errors.push({ code: "observation_validity", message: `observation ${obs.field}: source is required` });
  }

  if (!spec.termination || spec.termination.length === 0) {
    errors.push({ code: "termination_validity", message: "at least one termination condition is required" });
  }

  return { valid: errors.length === 0, errors };
}
