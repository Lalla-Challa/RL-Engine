/**
 * Reward engine — spec §18–19
 * R(Sₜ,Aₜ,Sₜ₊₁) and composable components R = Σ component × weight
 *
 * Phase G security pass (§40): expressions are compiled by a hand-written
 * shunting-yard parser — never the JS Function constructor or eval. The
 * evaluator accepts only numeric literals, `+ - * /`, parentheses, and dotted
 * field references into the provided record roots; any other token makes the
 * component 0 (fail-closed, never throws). Function calls are unreachable by
 * construction.
 */

import type { Action, RewardDef, RewardResult } from "../core/types";

type ExprContext = {
  /** Sₜ₊₁ (post-step) — "state.x" resolves against this. */
  state: Record<string, unknown>;
  prevState: Record<string, unknown>;
  nextState: Record<string, unknown>;
  action: Action;
};

const FIELD_RE = /(state|prevState|nextState|action)\.[\w.]+/g;

function resolveField(ctx: ExprContext, match: string): string {
  const parts = match.split(".");
  const root = parts[0];
  const path = parts.slice(1).join(".");
  let obj: unknown;
  if (root === "state") obj = ctx.nextState;
  else if (root === "prevState") obj = ctx.prevState;
  else if (root === "nextState") obj = ctx.nextState;
  else if (root === "action") {
    // GAP-3 (Phase D): action.value / action.type are addressable in reward
    // expressions so shaped rewards can key off what the agent actually did.
    if (path === "value") return String(typeof ctx.action.value === "number" ? ctx.action.value : 0);
    if (path === "type") return "0"; // strings are not numeric in expressions
    obj = (ctx.action.params ?? {}) as Record<string, unknown>;
  } else {
    return "0";
  }
  if (obj === null || typeof obj !== "object") return "0";
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object") { cur = undefined; break; }
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur === "number") return String(cur);
  if (typeof cur === "boolean") return cur ? "1" : "0";
  return "0";
}

/**
 * Sandboxed arithmetic compiler: shunting-yard → RPN → evaluation.
 * Accepts only numbers, + - * /, parentheses and whitespace after field
 * substitution. Anything else (identifiers, strings, function-call syntax)
 * makes the whole expression invalid → component contributes 0.
 */
export function compileArithmetic(expr: string): number | null {
  const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]|\s+/g);
  if (tokens === null) return null;
  if (tokens.join("").replace(/\s+/g, "") !== expr.replace(/\s+/g, "")) return null; // unknown chars present

  const output: string[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

  let prev: string | undefined;
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") continue;
    if (/^\d/.test(token)) {
      output.push(token);
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length > 0 && ops[ops.length - 1] !== "(") output.push(ops.pop()!);
      if (ops.pop() !== "(") return null; // unbalanced
    } else if (token in prec) {
      // unary minus: minus at expression start or after an operator/open-paren
      const unary = token === "-" && (prev === undefined || prev === "(" || prev in prec);
      if (unary) {
        output.push("0"); // 0 - x
      } else {
        while (ops.length > 0 && prec[ops[ops.length - 1]] >= prec[token]) output.push(ops.pop()!);
      }
      ops.push(token);
    } else {
      return null; // not an accepted token
    }
    prev = token;
  }
  while (ops.length > 0) {
    const op = ops.pop()!;
    if (op === "(") return null;
    output.push(op);
  }

  // Evaluate RPN
  const stack: number[] = [];
  for (const t of output) {
    if (/^\d/.test(t)) {
      stack.push(parseFloat(t));
      continue;
    }
    if (t in prec) {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      if (t === "+") stack.push(a + b);
      else if (t === "-") stack.push(a - b);
      else if (t === "*") stack.push(a * b);
      else {
        if (b === 0) return null; // divide by zero → invalid
        stack.push(a / b);
      }
    }
  }
  if (stack.length !== 1) return null;
  const value = stack[0];
  return Number.isFinite(value) ? value : null;
}

export function evaluateReward(
  prevState: Record<string, unknown>,
  action: Action,
  nextState: Record<string, unknown>,
  rewardDef: RewardDef
): RewardResult {
  const components: Record<string, number> = {};
  let total = 0;

  for (const comp of rewardDef?.components ?? []) {
    // "state" refers to Sₜ₊₁ (post-step) so delta expressions like
    // "state.battery - prevState.battery" yield per-step deltas.
    const ctx: ExprContext = { state: nextState, prevState, nextState, action };
    const substituted = comp.expression.replace(FIELD_RE, (m) => resolveField(ctx, m));
    const raw = compileArithmetic(substituted) ?? 0;
    const weighted = raw * comp.weight;
    components[comp.id] = weighted;
    total += weighted;
  }

  return { reward: total, components };
}
