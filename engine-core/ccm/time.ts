import type { CcmClock } from "./types";

/**
 * World clock operations. The clock is `{ day, minute }` where minute is
 * 0–1439. All timestamps are stored as world minutes = day * 1440 + minute.
 */

export function clockToMinutes(clock: CcmClock): number {
  return clock.day * 1440 + clock.minute;
}

export function minutesToClock(totalMinutes: number): CcmClock {
  const day = Math.floor(totalMinutes / 1440);
  const minute = totalMinutes % 1440;
  return { day, minute };
}

export function addMinutes(clock: CcmClock, mins: number): CcmClock {
  return minutesToClock(clockToMinutes(clock) + mins);
}

export function formatClock(clock: CcmClock): string {
  const h = Math.floor(clock.minute / 60);
  const m = clock.minute % 60;
  return `Day ${clock.day}, ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatTime(totalMinutes: number): string {
  return formatClock(minutesToClock(totalMinutes));
}

/**
 * Compare two clocks: returns -1/0/1.
 */
export function compareClocks(a: CcmClock, b: CcmClock): number {
  return clockToMinutes(a) - clockToMinutes(b);
}