import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const updateSchema = z.object({
  workStartMins: z.number().int().min(0).max(1439).optional(),
  workEndMins: z.number().int().min(0).max(1440).optional(),
  workDaysMask: z.number().int().min(0).max(127).optional(),
  focusBlockMins: z.number().int().min(0).max(480).optional(),
  timezone: z.string().optional(),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const prefs = await prisma.preferences.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  return NextResponse.json(prefs);
}

export async function PATCH(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const prefs = await prisma.preferences.upsert({
    where: { userId },
    update: parsed.data,
    create: { userId, ...parsed.data },
  });
  return NextResponse.json(prefs);
}
