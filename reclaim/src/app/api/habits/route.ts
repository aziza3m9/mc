import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const createSchema = z.object({
  title: z.string().min(1),
  perWeek: z.number().int().min(1).max(14),
  durationMins: z.number().int().positive(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  windowStartMins: z.number().int().min(0).max(1439).optional(),
  windowEndMins: z.number().int().min(0).max(1440).optional(),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const habits = await prisma.habit.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(habits);
}

export async function POST(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const habit = await prisma.habit.create({
    data: {
      userId,
      title: parsed.data.title,
      perWeek: parsed.data.perWeek,
      durationMins: parsed.data.durationMins,
      priority: parsed.data.priority ?? "MEDIUM",
      windowStartMins: parsed.data.windowStartMins ?? 360,
      windowEndMins: parsed.data.windowEndMins ?? 1320,
    },
  });
  return NextResponse.json(habit, { status: 201 });
}
