/**
 * Trajectory recorder — spec §26
 * τ = (s₀,a₀,r₁,s₁, a₁,r₂,s₂, ...)
 */

import type { Action, Observation, StepResult } from "../core/types";

export type TrajectoryStep = {
  observation: Observation;
  action: Action;
  reward: number;
  rewardComponents?: Record<string, number>;
  nextObservation: Observation;
  terminated: boolean;
  truncated: boolean;
  state: Record<string, unknown>;
};

export class TrajectoryRecorder {
  private steps: TrajectoryStep[] = [];

  record(step: TrajectoryStep): void {
    this.steps.push(step);
  }

  getTrajectory(): TrajectoryStep[] {
    return [...this.steps];
  }

  clear(): void {
    this.steps = [];
  }

  toJSON(): TrajectoryStep[] {
    return this.getTrajectory();
  }

  static fromJSON(data: TrajectoryStep[]): TrajectoryRecorder {
    const r = new TrajectoryRecorder();
    (r as unknown as { steps: TrajectoryStep[] }).steps = [...data];
    return r;
  }
}
