/**
 * Environment Compiler — spec §32
 * Spec → SchemaValidation → ReferenceResolution → RuleCompilation → ActionCompilation → RewardCompilation → ObservationCompilation → Executable
 *
 * Errors are fatal (the spec cannot run safely). Warnings are advisory and
 * never block compilation — they surface in `result.warnings`.
 */

import type { EnvironmentSpecification } from "../core/types";
import { checkSpecVersion, SUPPORTED_SPEC_VERSION } from "./specification";
import { SPEC_LIMITS } from "./limits";

export type CompilerError = { code: string; message: string; path?: string };

export type CompileResult = {
  ok: boolean;
  errors: CompilerError[];
  warnings: CompilerError[];
  spec?: EnvironmentSpecification;
};

const KNOWN_EFFECT_OPS = new Set([
  "set", "add", "subtract", "multiply", "divide", "append", "remove", "increment", "decrement", "create", "delete",
]);

const KNOWN_CONDITION_OPS = new Set([
  "eq", "ne", "==", "!=", "gt", "gte", "lt", "lte", ">", ">=", "<", "<=", "in", "not_in", "exists", "absent", "contains",
]);

export function compileEnvironment(spec: EnvironmentSpecification): CompileResult {
  const errors: CompilerError[] = [];
  const warnings: CompilerError[] = [];

  // ── spec-size limits (§40 hardening, Phase G) ──────────────────────────────
  const serialized = JSON.stringify(spec);
  if (serialized.length > SPEC_LIMITS.maxSpecBytes) {
    errors.push({ code: "spec_too_large", message: `spec exceeds ${SPEC_LIMITS.maxSpecBytes} bytes (${serialized.length})`, path: "environment" });
  }
  const countOf = (n: unknown): number => (Array.isArray(n) ? n.length : 0);
  const dims = spec.state ? Object.keys(spec.state).length : 0;
  if (dims > SPEC_LIMITS.maxStateFields) errors.push({ code: "spec_too_large", message: `state has ${dims} fields (max ${SPEC_LIMITS.maxStateFields})`, path: "state" });
  if (countOf(spec.entities) > SPEC_LIMITS.maxEntities) errors.push({ code: "spec_too_large", message: `too many entities (max ${SPEC_LIMITS.maxEntities})`, path: "entities" });
  if (countOf(spec.relationships) > SPEC_LIMITS.maxRelationships) errors.push({ code: "spec_too_large", message: `too many relationships (max ${SPEC_LIMITS.maxRelationships})`, path: "relationships" });
  if (countOf(spec.actions) > SPEC_LIMITS.maxActions) errors.push({ code: "spec_too_large", message: `too many action defs (max ${SPEC_LIMITS.maxActions})`, path: "actions" });
  if (countOf(spec.rules) > SPEC_LIMITS.maxRules) errors.push({ code: "spec_too_large", message: `too many rules (max ${SPEC_LIMITS.maxRules})`, path: "rules" });
  if (countOf(spec.observations?.fields) > SPEC_LIMITS.maxObservationFields) errors.push({ code: "spec_too_large", message: `too many observation fields (max ${SPEC_LIMITS.maxObservationFields})`, path: "observations" });
  if (countOf(spec.rewards?.components) > SPEC_LIMITS.maxRewardComponents) errors.push({ code: "spec_too_large", message: `too many reward components (max ${SPEC_LIMITS.maxRewardComponents})`, path: "rewards" });
  if (countOf(spec.constraints) > SPEC_LIMITS.maxConstraints) errors.push({ code: "spec_too_large", message: `too many constraints (max ${SPEC_LIMITS.maxConstraints})`, path: "constraints" });
  if (countOf(spec.termination) > SPEC_LIMITS.maxTerminationConditions) errors.push({ code: "spec_too_large", message: `too many termination conditions (max ${SPEC_LIMITS.maxTerminationConditions})`, path: "termination" });

  // Expression length caps (reward expressions are compiled, not evaluated raw)
  for (const rc of spec.rewards?.components ?? []) {
    if (typeof rc.expression === "string" && rc.expression.length > SPEC_LIMITS.maxExpressionLength) {
      errors.push({ code: "expression_too_long", message: `reward ${rc.id}: expression exceeds ${SPEC_LIMITS.maxExpressionLength} chars`, path: `rewards.${rc.id}` });
    }
  }

  // Condition-tree depth guard
  const depthOf = (node: unknown, depth: number): number => {
    if (node === null || typeof node !== "object") return depth;
    const n = node as Record<string, unknown>;
    if (!("all" in n || "any" in n || "not" in n)) return depth;
    let max = depth + 1;
    if (max > SPEC_LIMITS.maxConditionDepth) return max;
    for (const child of ((n.all as unknown[]) ?? []).concat((n.any as unknown[]) ?? [])) max = Math.max(max, depthOf(child, depth + 1));
    if (n.not !== undefined) max = Math.max(max, depthOf(n.not, depth + 1));
    return max;
  };
  for (const rule of spec.rules ?? []) {
    for (const cond of rule.conditions ?? []) {
      if (depthOf(cond, 0) > SPEC_LIMITS.maxConditionDepth) {
        errors.push({ code: "condition_too_deep", message: `rule ${rule.id}: condition nesting exceeds ${SPEC_LIMITS.maxConditionDepth}`, path: `rules.${rule.id}` });
      }
    }
    if ((rule.conditions ?? []).length > SPEC_LIMITS.maxConditionsPerRule) errors.push({ code: "spec_too_large", message: `rule ${rule.id}: too many conditions (max ${SPEC_LIMITS.maxConditionsPerRule})` });
    if (countOf(rule.effects) > SPEC_LIMITS.maxEffectsPerRule) errors.push({ code: "spec_too_large", message: `rule ${rule.id}: too many effects (max ${SPEC_LIMITS.maxEffectsPerRule})` });
    const outcomes = (rule as unknown as { outcomes?: unknown[] }).outcomes;
    if (countOf(outcomes) > SPEC_LIMITS.maxOutcomeCount) errors.push({ code: "spec_too_large", message: `rule ${rule.id}: too many outcomes (max ${SPEC_LIMITS.maxOutcomeCount})` });
  }

  // ── version forward-compat (§32) ───────────────────────────────────────────
  const version = checkSpecVersion(spec);
  if (!version.compatible) {
    if (version.fatal) errors.push({ code: "unsupported_spec_version", message: version.reason ?? "incompatible specVersion", path: "environment.specVersion" });
    else warnings.push({ code: "spec_version_mismatch", message: version.reason ?? "specVersion differs", path: "environment.specVersion" });
  }

  // ── meta ───────────────────────────────────────────────────────────────────
  if (!spec.environment?.id) errors.push({ code: "missing_id", message: "environment.id is required", path: "environment.id" });
  if (!spec.environment?.version) errors.push({ code: "missing_version", message: "environment.version is required", path: "environment.version" });

  // ── state schema (§6): types, bounds, defaults, immutability ──────────────
  for (const [field, def] of Object.entries(spec.state ?? {})) {
    if (!def.type) errors.push({ code: "invalid_state_def", message: `state.${field}: type is required`, path: `state.${field}` });
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      errors.push({ code: "invalid_range", message: `state.${field}: min > max`, path: `state.${field}` });
    }
    if (def.default !== undefined) {
      if (def.type === "integer" && (typeof def.default !== "number" || !Number.isInteger(def.default))) {
        errors.push({ code: "invalid_default", message: `state.${field}: default is not an integer`, path: `state.${field}` });
      }
      if (def.type === "float" && typeof def.default !== "number") {
        errors.push({ code: "invalid_default", message: `state.${field}: default is not a number`, path: `state.${field}` });
      }
      if (def.type === "boolean" && typeof def.default !== "boolean") {
        errors.push({ code: "invalid_default", message: `state.${field}: default is not a boolean`, path: `state.${field}` });
      }
      if (def.type === "string" && typeof def.default !== "string") {
        errors.push({ code: "invalid_default", message: `state.${field}: default is not a string`, path: `state.${field}` });
      }
      if (def.type === "enum" && def.allowedValues && !def.allowedValues.includes(def.default)) {
        errors.push({ code: "invalid_default", message: `state.${field}: default not in allowedValues`, path: `state.${field}` });
      }
      if (typeof def.default === "number") {
        if (def.min !== undefined && (def.default as number) < def.min) errors.push({ code: "invalid_default", message: `state.${field}: default below min`, path: `state.${field}` });
        if (def.max !== undefined && (def.default as number) > def.max) errors.push({ code: "invalid_default", message: `state.${field}: default above max`, path: `state.${field}` });
      }
    }
  }

  // ── reference resolution (§32 stage 2) ─────────────────────────────────────
  const entityIds = new Set((spec.entities ?? []).map((e) => e.id));
  const relIds = new Set((spec.relationships ?? []).map((r) => r.id));

  const checkTarget = (target: string, where: string): void => {
    if (target === "state") return;
    if (target.startsWith("entity:")) {
      if (!entityIds.has(target.slice("entity:".length))) {
        errors.push({ code: "unknown_target", message: `${where}: unknown entity target "${target}"`, path: where });
      }
      return;
    }
    if (target.startsWith("rel:")) {
      if (!relIds.has(target.slice("rel:".length))) {
        errors.push({ code: "unknown_target", message: `${where}: unknown relationship target "${target}"`, path: where });
      }
      return;
    }
    errors.push({ code: "unknown_target", message: `${where}: unresolvable target "${target}" (expected "state", "entity:<id>" or "rel:<id>")`, path: where });
  };

  const checkConditionNode = (node: unknown, where: string): void => {
    if (node === null || typeof node !== "object") {
      errors.push({ code: "invalid_condition", message: `${where}: condition must be an object`, path: where });
      return;
    }
    const n = node as Record<string, unknown>;
    if ("all" in n || "any" in n || "not" in n) {
      for (const child of (n.all as unknown[]) ?? []) checkConditionNode(child, where);
      for (const child of (n.any as unknown[]) ?? []) checkConditionNode(child, where);
      if (n.not !== undefined) checkConditionNode(n.not, where);
      return;
    }
    if (typeof n.field !== "string") errors.push({ code: "invalid_condition", message: `${where}: condition.field is required`, path: where });
    if (typeof n.op !== "string") {
      errors.push({ code: "invalid_condition", message: `${where}: condition.op is required`, path: where });
    } else if (!KNOWN_CONDITION_OPS.has(n.op)) {
      errors.push({ code: "invalid_condition_op", message: `${where}: unknown condition op "${n.op}"`, path: where });
    }
  };

  // ── rules (§10): ops, probability sums, effect targets, circular cooldowns ─
  for (const rule of spec.rules ?? []) {
    if (!rule.id) { errors.push({ code: "invalid_rule", message: "rule.id is required" }); continue; }
    if (rule.priority === undefined) warnings.push({ code: "missing_priority", message: `rule ${rule.id}: no priority (defaults to evaluation order)`, path: `rules.${rule.id}` });

    for (const cond of rule.conditions ?? []) checkConditionNode(cond, `rule ${rule.id} condition`);

    const outcomes = (rule as unknown as { outcomes?: { id?: string; probability: number; effects?: { target: string }[] }[] }).outcomes;
    if (outcomes && outcomes.length > 0) {
      const sum = outcomes.reduce((s, o) => s + o.probability, 0);
      if (Math.abs(sum - 1.0) > 1e-6) {
        errors.push({ code: "impossible_probability", message: `rule ${rule.id}: outcomes probabilities sum to ${sum}, expected 1.0` });
      }
      for (const o of outcomes) {
        if (typeof o.probability !== "number" || o.probability < 0 || o.probability > 1) {
          errors.push({ code: "impossible_probability", message: `rule ${rule.id} outcome ${o.id ?? "?"}: probability out of [0,1]` });
        }
        for (const eff of o.effects ?? []) checkTarget(eff.target, `rule ${rule.id} outcome ${o.id ?? "?"} effect`);
      }
    }

    for (const eff of rule.effects ?? []) {
      if (!eff.op) errors.push({ code: "invalid_effect", message: `rule ${rule.id}: effect op is required` });
      else if (!KNOWN_EFFECT_OPS.has(eff.op)) errors.push({ code: "invalid_effect_op", message: `rule ${rule.id}: unknown effect op "${eff.op}"` });
      if (eff.target === undefined) errors.push({ code: "invalid_effect", message: `rule ${rule.id}: effect target is required` });
      else checkTarget(eff.target, `rule ${rule.id} effect`);
    }
  }

  // Duplicate rule ids would silently shadow each other.
  const ruleIds = (spec.rules ?? []).map((r) => r.id);
  for (const id of ruleIds) {
    if (ruleIds.indexOf(id) !== ruleIds.lastIndexOf(id)) {
      errors.push({ code: "duplicate_rule_id", message: `duplicate rule id "${id}"` });
    }
  }

  // ── constraints / termination / rewards ────────────────────────────────────
  for (const c of spec.constraints ?? []) {
    if (!c.id) errors.push({ code: "invalid_constraint", message: "constraint.id is required" });
  }

  for (const t of spec.termination ?? []) {
    if (!t.field && t.maxSteps === undefined) errors.push({ code: "invalid_termination", message: "termination: field or maxSteps required" });
    if (t.field && t.kind === "terminated" && spec.state?.[t.field] === undefined) {
      warnings.push({ code: "unknown_termination_field", message: `termination field "${t.field}" is not in the state schema` });
    }
  }

  for (const rc of spec.rewards?.components ?? []) {
    if (!rc.id) errors.push({ code: "invalid_reward", message: "reward component id is required" });
    if (typeof rc.weight !== "number") errors.push({ code: "invalid_reward", message: `reward ${rc.id}: weight must be a number` });
  }

  // ── action-space validation (§5) — GAP-1 platform support ─────────────────
  for (const a of spec.actions ?? []) {
    if (a.kind === "continuous") {
      if (!a.type) errors.push({ code: "invalid_action_def", message: "continuous action def requires a type" });
      if (typeof a.min !== "number" || typeof a.max !== "number" || a.min > a.max) {
        errors.push({ code: "invalid_action_def", message: `continuous action "${a.type ?? "?"}": min/max inverted or missing` });
      }
      if (!a.field) errors.push({ code: "invalid_action_def", message: `continuous action "${a.type ?? "?"}": field is required` });
    } else if (a.kind === "multiDiscrete") {
      if (!a.type) errors.push({ code: "invalid_action_def", message: "multiDiscrete action def requires a type" });
      if (!a.dims || a.dims.length === 0) errors.push({ code: "invalid_action_def", message: `multiDiscrete action "${a.type ?? "?"}": dims required` });
      for (const d of a.dims ?? []) {
        if (!d.field || !Array.isArray(d.values) || d.values.length === 0) {
          errors.push({ code: "invalid_action_def", message: `multiDiscrete action "${a.type ?? "?"}": dim needs a field and non-empty values` });
        }
      }
    } else if (a.kind === "conditional") {
      if (!a.type) errors.push({ code: "invalid_action_def", message: "conditional action def requires a type" });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors: [], warnings, spec };
}
