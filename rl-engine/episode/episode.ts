/**
 * Episode lifecycle — spec §20
 * CREATE → RESET → STEP* → TERMINATED
 */

export type EpisodeStatus = "created" | "running" | "terminated" | "truncated";

export type Episode = {
  id: string;
  status: EpisodeStatus;
  stepCount: number;
  seed: number | string;
  createdAt: number;
};
