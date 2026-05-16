import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";
import { createEvent, deleteEvent, getBusy } from "@/lib/google-calendar";
import { plan } from "@/lib/scheduler";

const HORIZON_DAYS = 7;

// Preview: compute the plan without writing to Google Calendar.
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [prefs, tasks, habits] = await Promise.all([
    prisma.preferences.upsert({ where: { userId }, update: {}, create: { userId } }),
    prisma.task.findMany({ where: { userId, completed: false } }),
    prisma.habit.findMany({ where: { userId } }),
  ]);

  const now = new Date();
  const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const busy = await getBusy(userId, now, horizonEnd);

  const result = plan(prefs, tasks, habits, busy, now, HORIZON_DAYS);
  return NextResponse.json(result);
}

// Commit: compute the plan and write events to Google Calendar.
export async function POST(_req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [prefs, tasks, habits, existingBlocks] = await Promise.all([
    prisma.preferences.upsert({ where: { userId }, update: {}, create: { userId } }),
    prisma.task.findMany({ where: { userId, completed: false } }),
    prisma.habit.findMany({ where: { userId } }),
    prisma.scheduledBlock.findMany({ where: { userId } }),
  ]);

  // Wipe previously-written blocks before recomputing, so re-running is idempotent.
  for (const block of existingBlocks) {
    if (block.googleEventId) {
      try {
        await deleteEvent(userId, block.googleEventId);
      } catch {
        // event may have been deleted manually; ignore
      }
    }
  }
  await prisma.scheduledBlock.deleteMany({ where: { userId } });

  const now = new Date();
  const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const busy = await getBusy(userId, now, horizonEnd);

  const result = plan(prefs, tasks, habits, busy, now, HORIZON_DAYS);

  const created = [];
  for (const a of result.assignments) {
    const summary = a.taskId ? `[Task] ${a.title}` : `[Habit] ${a.title}`;
    const event = await createEvent(userId, {
      summary,
      description: "Auto-scheduled by Reclaim",
      start: a.start,
      end: a.end,
    });
    const block = await prisma.scheduledBlock.create({
      data: {
        userId,
        taskId: a.taskId ?? null,
        habitId: a.habitId ?? null,
        googleEventId: event.id ?? null,
        start: a.start,
        end: a.end,
      },
    });
    created.push(block);
  }

  return NextResponse.json({
    created: created.length,
    unscheduledTasks: result.unscheduledTasks,
    unscheduledHabits: result.unscheduledHabits,
  });
}
