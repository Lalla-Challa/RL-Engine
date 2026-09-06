/**
 * Human feedback — spec §36–38
 * Scalar, preference, ranking, critique. Stored separately from environment def.
 */

export type ScalarFeedback = { type: "scalar"; value: number };
export type PreferenceFeedback = { type: "preference"; preferred: string; other: string };
export type RankingFeedback = { type: "ranking"; order: string[] };
export type CritiqueFeedback = { type: "critique"; trajectoryId: string; message: string };

export type HumanFeedback = ScalarFeedback | PreferenceFeedback | RankingFeedback | CritiqueFeedback;

export class FeedbackStore {
  private items: HumanFeedback[] = [];
  add(item: HumanFeedback): void {
    this.items.push(item);
  }
  list(): HumanFeedback[] {
    return [...this.items];
  }
}
