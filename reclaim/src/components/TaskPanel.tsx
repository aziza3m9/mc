"use client";

import { useEffect, useState } from "react";

type Task = {
  id: string;
  title: string;
  durationMins: number;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  deadline: string | null;
  completed: boolean;
};

export function TaskPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [durationMins, setDurationMins] = useState(60);
  const [priority, setPriority] = useState<Task["priority"]>("MEDIUM");
  const [deadline, setDeadline] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const r = await fetch("/api/tasks");
    if (r.ok) setTasks(await r.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = { title, durationMins: Number(durationMins), priority };
      if (deadline) body.deadline = new Date(deadline).toISOString();
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTitle("");
      setDeadline("");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function toggle(t: Task) {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !t.completed }),
    });
    void load();
  }

  async function remove(id: string) {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <div className="panel">
      <h2>Tasks</h2>
      <form onSubmit={add} className="stack">
        <div>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Draft Q3 plan" />
        </div>
        <div className="row">
          <div>
            <label>Duration (mins)</label>
            <input
              type="number"
              min={15}
              step={15}
              value={durationMins}
              onChange={(e) => setDurationMins(Number(e.target.value))}
            />
          </div>
          <div>
            <label>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </div>
        </div>
        <div>
          <label>Deadline (optional)</label>
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
        <button disabled={loading}>Add task</button>
      </form>

      <ul className="list" style={{ marginTop: 16 }}>
        {tasks.map((t) => (
          <li key={t.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={t.completed} onChange={() => toggle(t)} />
              <div>
                <div style={{ textDecoration: t.completed ? "line-through" : "none" }}>{t.title}</div>
                <div className="muted">
                  {t.durationMins}m · <span className={`pill ${t.priority}`}>{t.priority}</span>
                  {t.deadline ? ` · due ${new Date(t.deadline).toLocaleString()}` : ""}
                </div>
              </div>
            </div>
            <button className="secondary" onClick={() => remove(t.id)}>Delete</button>
          </li>
        ))}
        {tasks.length === 0 && <li className="muted">No tasks yet.</li>}
      </ul>
    </div>
  );
}
