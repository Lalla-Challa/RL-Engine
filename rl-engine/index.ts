/**
 * rl-engine — public entry point (spec §41 api layer).
 * The engine is domain-independent: no story concepts, no DB, no Math.random.
 */

// Core primitives
export * from "./core/types";
export * from "./core/state";
export * from "./core/randomness";
export * from "./core/transitions";
export * from "./core/validation";

// Environment
export { compileEnvironment } from "./environment/compiler";
export type { CompileResult, CompilerError } from "./environment/compiler";
export { validateEnvironment } from "./environment/validator";
export { createEnvironment } from "./environment/environment";
export { specId, checkSpecVersion, SUPPORTED_SPEC_VERSION } from "./environment/specification";

// Observation + Reward
export { compileObservation } from "./observation/observation";
export { compileObservationSpace } from "./observation/observationCompiler";
export { evaluateReward } from "./reward/reward";
export { compileReward } from "./reward/rewardCompiler";

// Episode / trajectory / replay
export type { Episode, EpisodeStatus } from "./episode/episode";
export { TrajectoryRecorder } from "./episode/trajectory";
export type { TrajectoryStep } from "./episode/trajectory";
export { replay } from "./episode/replay";

// Events
export type { EngineEvent } from "./events/event";
export { linkCauses } from "./events/causalGraph";

// Plugins
export type { Plugin } from "./plugins/plugin";
export { PluginRegistry, safeFunctions } from "./plugins/registry";

// Persistence
export { loadSpecFromFile, loadSpecFromObject } from "./persistence/loader";
export { persistTrajectory, persistSpec } from "./persistence/persister";
export type { PersistenceAdapter, SnapshotMeta } from "./persistence/adapter";
export { FilePersistenceAdapter } from "./persistence/fileAdapter";
export { SqlCipherPersistenceAdapter, deriveKeyHex } from "./persistence/sqlCipherAdapter";
export type { SqlCipherAdapterOptions } from "./persistence/sqlCipherAdapter";
export type { EngineSnapshot, SnapshottableEnvironment } from "./environment/snapshot";
export { SNAPSHOT_VERSION, sha256Canonical } from "./environment/snapshot";

// RL layer (thin interfaces, spec §34-38)
export type { Policy } from "./rl/policy";
export { RandomPolicy } from "./rl/policy";
export type { Trainer, TrainContext, EpisodeResult, EnvironmentFactory } from "./rl/trainer";
export { NoopTrainer } from "./rl/trainer";
export { rollout } from "./rl/rollout";
export { ReplayBuffer } from "./rl/replayBuffer";
export type { ReplayEntry, ReplayBufferJSON } from "./rl/replayBuffer";
export {
  discreteActionCatalog,
  makeDiscretizer,
  TabularQPolicy,
  QLearningTrainer,
} from "./rl/qlearning";
export type {
  DiscretizerConfig,
  DiscretizerField,
  TabularQCheckpoint,
  QLearningConfig,
  QLearningCheckpoint,
} from "./rl/qlearning";
export type { HumanFeedback } from "./rl/feedback";
export { FeedbackStore } from "./rl/feedback";

// Testing harnesses
export { gate, trajectoryHash } from "./testing/determinism";
export type { GateResult } from "./testing/determinism";
export { testEnvironment } from "./testing/environmentTests";
export { testProperties } from "./testing/propertyTests";
export type { PropertyReport } from "./testing/propertyTests";
