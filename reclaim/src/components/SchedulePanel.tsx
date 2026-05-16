"use client";

import { useState } from "react";

type Assignment = {
  start: string;
  end: string;
  taskId?: string;
  habitId?: string;
  title: string;
};

type Preview = {
  assignments: Assignment[];
  unscheduledTasks: { taskId: string; reason: string }[];
  unscheduledHabits: { habitId: string; reason: string }[];
};

function groupByDay(items: Assignment[]) {
  const map = new Map<string, Assignment[]>();
  for (const a of items) {
    const d = new Date(a.start);
    const key = d.toDateString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(a);
  }
  return map;
}

function fmtRange(a: Assignment) {
  const s = new Date(a.start);
  const e = new Date(a.end);
  const f = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${f(s)} – ${f(e)}`;
}

export function SchedulePanel() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ created: number } | null>(null);

  async function runPreview() {
    setBusy(true);
    setError(null);
    setCommitted(null);
    try {
      const r = await fetch("/api/schedule");
      if (!r.ok) throw new Error(await r.text());
      setPreview(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!confirm("Write these blocks to your Google Calendar? Existing auto-scheduled blocks will be replaced.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/schedule", { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setCommitted({ created: data.created });
      await runPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const grouped = preview ? groupByDay(preview.assignments) : null;

  return (
    <div className="panel">
      <h2>Schedule</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={runPreview} disabled={busy}>Preview plan</button>
        <button onClick={commit} disabled={busy || !preview || preview.assignments.length === 0}>
          Write to Google Calendar
        </button>
      </div>
      {error && <div className="muted" style={{ color: "var(--danger)" }}>{error}</div>}
      {committed && <div className="muted">Created {committed.created} events.</div>}

      {grouped && (
        <div className="stack-lg">
          {[...grouped.entries()].map(([day, items]) => (
            <div key={day}>
              <div className="muted" style={{ marginBottom: 6 }}>{day}</div>
              <ul className="list">
                {items.map((a, i) => (
                  <li key={i}>
                    <div>
                      <div>{a.title}</div>
                      <div className="muted">
                        {fmtRange(a)} · <span className="pill">{a.taskId ? "Task" : "Habit"}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {preview && preview.assignments.length === 0 && (
            <div className="muted">No blocks scheduled. Add tasks or habits and adjust your working hours.</div>
          )}
          {preview && (preview.unscheduledTasks.length > 0 || preview.unscheduledHabits.length > 0) && (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>Couldn&apos;t schedule</div>
              <ul className="list">
                {preview.unscheduledTasks.map((u, i) => (
                  <li key={`t${i}`}>
                    <div className="muted">Task: {u.reason}</div>
                  </li>
                ))}
                {preview.unscheduledHabits.map((u, i) => (
                  <li key={`h${i}`}>
                    <div className="muted">Habit: {u.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
