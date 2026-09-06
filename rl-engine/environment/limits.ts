/**
 * Spec-size limits (Phase G, §40) — hard caps so a (possibly adversarial)
 * EnvironmentSpecification cannot exhaust memory or CPU at compile or run time.
 * Enforced by the Environment Compiler; documented in the authoring contract.
 */

export const SPEC_LIMITS = {
  /** Serialized spec size in UTF-8 bytes. */
  maxSpecBytes: 1_000_000,
  maxStateFields: 500,
  maxEntities: 5000,
  maxRelationships: 5000,
  maxActions: 200,
  maxRules: 500,
  maxConditionsPerRule: 64,
  maxEffectsPerRule: 64,
  maxOutcomeCount: 32,
  maxObservationFields: 200,
  maxRewardComponents: 64,
  maxConstraints: 200,
  maxTerminationConditions: 32,
  /** Max characters of any reward/observation expression string. */
  maxExpressionLength: 2000,
  /** Max condition-tree nesting depth (all/any/not chains). */
  maxConditionDepth: 16,
} as const;

export type SpecLimitKey = keyof typeof SPEC_LIMITS;
