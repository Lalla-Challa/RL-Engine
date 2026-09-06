/**
 * Policy interface — spec §35
 * Training layer is separate from the environment engine. The environment
 * never knows which algorithm acts inside it.
 */

import type { Action, Observation } from "../core/types";
import { createRandomService } from "../core/randomness";

export interface Policy {
  act(observation: Observation): Action;
  update(batch: unknown): void;
  save(path: string): void;
  load(path: string): void;
}

/** Reference random policy — seeded so rollouts stay reproducible (§28, §44). */
export class RandomPolicy implements Policy {
  private actions: string[];
  private rng = createRandomService(42);

  constructor(actions: string[], seed: number | string = 42) {
    this.actions = actions;
    this.rng = createRandomService(seed);
  }

  act(_obs: Observation): Action {
    return { type: this.rng.choice(this.actions) };
  }
  update(_batch: unknown): void {}
  save(_path: string): void {}
  load(_path: string): void {}
}
