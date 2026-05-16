import type { Habit, Preferences, Task } from "@prisma/client";

export type Interval = { start: Date; end: Date };
export type Assignment = {
  start: Date;
  end: Date;
  taskId?: string;
  habitId?: string;
  title: string;
};

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const MIN = 60 * 1000;

function addMinutes(d: Date, mins: number) {
  return new Date(d.getTime() + mins * MIN);
}

function startOfDay(d: Date) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function weekdayBit(d: Date) {
  // 0=Sun..6=Sat
  return 1 << d.getDay();
}

function clamp(i: Interval, bounds: Interval): Interval | null {
  const s = i.start < bounds.start ? bounds.start : i.start;
  const e = i.end > bounds.end ? bounds.end : i.end;
  return e.getTime() - s.getTime() >= MIN ? { start: s, end: e } : null;
}

// Subtract busy intervals from a list of free intervals.
export function subtractBusy(free: Interval[], busy: Interval[]): Interval[] {
  const sortedBusy = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const slot of free) {
    let cursor = slot.start;
    for (const b of sortedBusy) {
      if (b.end <= cursor) continue;
      if (b.start >= slot.end) break;
      if (b.start > cursor) {
        out.push({ start: cursor, end: b.start < slot.end ? b.start : slot.end });
      }
      if (b.end > cursor) cursor = b.end;
      if (cursor >= slot.end) break;
    }
    if (cursor < slot.end) out.push({ start: cursor, end: slot.end });
  }
  return out.filter((i) => i.end.getTime() - i.start.getTime() >= MIN);
}

// Build the workday windows for each day in the horizon, respecting work hours + work days mask.
export function workWindows(prefs: Preferences, from: Date, days: number): Interval[] {
  const out: Interval[] = [];
  const day0 = startOfDay(from);
  for (let i = 0; i < days; i++) {
    const d = new Date(day0);
    d.setDate(day0.getDate() + i);
    if ((prefs.workDaysMask & weekdayBit(d)) === 0) continue;
    const start = addMinutes(d, prefs.workStartMins);
    const end = addMinutes(d, prefs.workEndMins);
    const clamped = clamp({ start, end }, { start: from, end: addMinutes(day0, (days + 1) * 1440) });
    if (clamped) out.push(clamped);
  }
  return out;
}

// Daily habit window across the horizon (independent of work days/hours).
export function habitWindows(habit: Habit, from: Date, days: number): Interval[] {
  const out: Interval[] = [];
  const day0 = startOfDay(from);
  for (let i = 0; i < days; i++) {
    const d = new Date(day0);
    d.setDate(day0.getDate() + i);
    const start = addMinutes(d, habit.windowStartMins);
    const end = addMinutes(d, habit.windowEndMins);
    const clamped = clamp({ start, end }, { start: from, end: addMinutes(day0, (days + 1) * 1440) });
    if (clamped) out.push(clamped);
  }
  return out;
}

function placeChunk(
  free: Interval[],
  durationMins: number,
  notBefore?: Date,
  notAfter?: Date,
): { slot: Interval; index: number } | null {
  for (let i = 0; i < free.length; i++) {
    const slot = free[i];
    const earliest = notBefore && notBefore > slot.start ? notBefore : slot.start;
    const latestStart = addMinutes(slot.end, -durationMins);
    if (earliest > latestStart) continue;
    const start = earliest;
    const end = addMinutes(start, durationMins);
    if (notAfter && end > notAfter) continue;
    return { slot: { start, end }, index: i };
  }
  return null;
}

function removeFromFree(free: Interval[], used: Interval): Interval[] {
  return subtractBusy(free, [used]);
}

export function scheduleTasks(
  tasks: Task[],
  free: Interval[],
  now: Date,
): { assignments: Assignment[]; unscheduled: { taskId: string; reason: string }[]; remaining: Interval[] } {
  const assignments: Assignment[] = [];
  const unscheduled: { taskId: string; reason: string }[] = [];

  const sorted = [...tasks].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 99;
    const pb = PRIORITY_RANK[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    const da = a.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    const db = b.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
    return da - db;
  });

  let remaining = free;
  for (const task of sorted) {
    let left = task.durationMins;
    let chunks = 0;
    while (left > 0) {
      const chunkSize = Math.min(left, task.maxChunkMins);
      if (chunkSize < task.minChunkMins && chunks > 0) {
        // last sliver smaller than min chunk: try to absorb it into the previous chunk if possible.
        break;
      }
      const placed = placeChunk(remaining, chunkSize, now, task.deadline ?? undefined);
      if (!placed) {
        unscheduled.push({
          taskId: task.id,
          reason: chunks === 0 ? "no free slot before deadline" : "could not place remaining chunk",
        });
        break;
      }
      assignments.push({
        start: placed.slot.start,
        end: placed.slot.end,
        taskId: task.id,
        title: task.title,
      });
      remaining = removeFromFree(remaining, placed.slot);
      left -= chunkSize;
      chunks += 1;
    }
  }

  return { assignments, unscheduled, remaining };
}

export function scheduleHabits(
  habits: Habit[],
  busy: Interval[],
  now: Date,
  days: number,
): { assignments: Assignment[]; unscheduled: { habitId: string; reason: string }[] } {
  const assignments: Assignment[] = [];
  const unscheduled: { habitId: string; reason: string }[] = [];

  for (const habit of habits) {
    const windows = habitWindows(habit, now, days);
    let free = subtractBusy(windows, busy);
    // Track placements per ISO-week so we don't over-place.
    const placedPerDay = new Set<string>();

    // Spread perWeek across the 7-day horizon. Goal: at most one session per day, distributed.
    let placedCount = 0;
    const target = habit.perWeek;

    while (placedCount < target) {
      // Find earliest slot whose day hasn't already been used.
      let chosen: { slot: Interval; index: number } | null = null;
      for (let i = 0; i < free.length; i++) {
        const slot = free[i];
        const key = dayKey(slot.start);
        if (placedPerDay.has(key)) continue;
        if (slot.end.getTime() - slot.start.getTime() < habit.durationMins * MIN) continue;
        chosen = {
          slot: { start: slot.start, end: addMinutes(slot.start, habit.durationMins) },
          index: i,
        };
        break;
      }
      if (!chosen) {
        unscheduled.push({
          habitId: habit.id,
          reason: `only placed ${placedCount}/${target} sessions this week`,
        });
        break;
      }
      assignments.push({
        start: chosen.slot.start,
        end: chosen.slot.end,
        habitId: habit.id,
        title: habit.title,
      });
      placedPerDay.add(dayKey(chosen.slot.start));
      free = removeFromFree(free, chosen.slot);
      placedCount += 1;
    }
  }

  return { assignments, unscheduled };
}

export type ScheduleResult = {
  assignments: Assignment[];
  unscheduledTasks: { taskId: string; reason: string }[];
  unscheduledHabits: { habitId: string; reason: string }[];
};

// Top-level entry: schedules habits first (their windows include non-work hours)
// then fits tasks into remaining work-hour slots, while also respecting a daily focus reserve.
export function plan(
  prefs: Preferences,
  tasks: Task[],
  habits: Habit[],
  busy: Interval[],
  now: Date,
  horizonDays: number = 7,
): ScheduleResult {
  const habitResult = scheduleHabits(habits, busy, now, horizonDays);
  const busyWithHabits: Interval[] = [
    ...busy,
    ...habitResult.assignments.map((a) => ({ start: a.start, end: a.end })),
  ];

  const work = workWindows(prefs, now, horizonDays);
  const freeForTasks = subtractBusy(work, busyWithHabits);

  const taskResult = scheduleTasks(tasks.filter((t) => !t.completed), freeForTasks, now);

  return {
    assignments: [...habitResult.assignments, ...taskResult.assignments].sort(
      (a, b) => a.start.getTime() - b.start.getTime(),
    ),
    unscheduledTasks: taskResult.unscheduled,
    unscheduledHabits: habitResult.unscheduled,
  };
}
