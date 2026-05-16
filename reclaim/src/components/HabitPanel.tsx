"use client";

import { useEffect, useState } from "react";

type Habit = {
  id: string;
  title: string;
  perWeek: number;
  durationMins: number;
  priority: string;
  windowStartMins: number;
  windowEndMins: number;
};

function fmtMins(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function HabitPanel() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [title, setTitle] = useState("");
  const [perWeek, setPerWeek] = useState(3);
  const [durationMins, setDurationMins] = useState(30);
  const [loading, setLoading] = useState(false);

  async function load() {
    const r = await fetch("/api/habits");
    if (r.ok) setHabits(await r.json());
  }

  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      await fetch("/api/habits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, perWeek: Number(perWeek), durationMins: Number(durationMins) }),
      });
      setTitle("");
      await load();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Habits</h2>
      <form onSubmit={add} className="stack">
        <div>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Gym session" />
        </div>
        <div className="row">
          <div>
            <label>Sessions / week</label>
            <input
              type="number"
              min={1}
              max={14}
              value={perWeek}
              onChange={(e) => setPerWeek(Number(e.target.value))}
            />
          </div>
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
        </div>
        <button disabled={loading}>Add habit</button>
      </form>

      <ul className="list" style={{ marginTop: 16 }}>
        {habits.map((h) => (
          <li key={h.id}>
            <div>
              <div>{h.title}</div>
              <div className="muted">
                {h.perWeek}× / week · {h.durationMins}m · window {fmtMins(h.windowStartMins)}–{fmtMins(h.windowEndMins)}
              </div>
            </div>
          </li>
        ))}
        {habits.length === 0 && <li className="muted">No habits yet.</li>}
      </ul>
    </div>
  );
}
