import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const createSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional(),
  durationMins: z.number().int().positive(),
  minChunkMins: z.number().int().positive().optional(),
  maxChunkMins: z.number().int().positive().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  deadline: z.string().datetime().optional(),
});

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tasks = await prisma.task.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(tasks);
}

export async function POST(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const data = parsed.data;
  const task = await prisma.task.create({
    data: {
      userId,
      title: data.title,
      notes: data.notes,
      durationMins: data.durationMins,
      minChunkMins: data.minChunkMins ?? 30,
      maxChunkMins: data.maxChunkMins ?? 120,
      priority: data.priority ?? "MEDIUM",
      deadline: data.deadline ? new Date(data.deadline) : null,
    },
  });
  return NextResponse.json(task, { status: 201 });
}
