/**
 * Call counter harness — counts step() calls for 100+ trace validation.
 */

export class CallCounter {
  private count = 0;
  private trace: { action: string; reward: number; terminated: boolean }[] = [];

  record(action: string, reward: number, terminated: boolean): void {
    this.count++;
    this.trace.push({ action, reward, terminated });
  }

  getCount(): number {
    return this.count;
  }

  getTrace(): { action: string; reward: number; terminated: boolean }[] {
    return [...this.trace];
  }

  toJSON(): { count: number; trace: { action: string; reward: number; terminated: boolean }[] } {
    return { count: this.count, trace: this.trace };
  }
}
