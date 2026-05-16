import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUserId } from "@/lib/session";

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  durationMins: z.number().int().positive().optional(),
  minChunkMins: z.number().int().positive().optional(),
  maxChunkMins: z.number().int().positive().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  deadline: z.string().datetime().nullable().optional(),
  completed: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const existing = await prisma.task.findFirst({ where: { id: params.id, userId } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { deadline, ...rest } = parsed.data;
  const updated = await prisma.task.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...(deadline !== undefined ? { deadline: deadline ? new Date(deadline) : null } : {}),
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const existing = await prisma.task.findFirst({ where: { id: params.id, userId } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.task.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
