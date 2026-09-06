/**
 * Plugin interface — spec §30
 * Domain-specific functionality via plugins. Core never imports domain plugins.
 */

export type PluginHooks = {
  onBeforeStep?: (action: unknown, state: Record<string, unknown>) => void;
  onAfterStep?: (result: unknown, state: Record<string, unknown>) => void;
};

export interface Plugin {
  name: string;
  hooks?: PluginHooks;
  customValidators?: Record<string, (value: unknown) => string | null>;
  customTransitions?: Record<string, (state: Record<string, unknown>, params: unknown) => void>;
  customRewards?: Record<string, (ctx: unknown) => number>;
  customObservations?: Record<string, (state: Record<string, unknown>) => unknown>;
}
