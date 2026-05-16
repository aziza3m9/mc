"use client";

import { useEffect, useState } from "react";

type Prefs = {
  workStartMins: number;
  workEndMins: number;
  workDaysMask: number;
  focusBlockMins: number;
  timezone: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minsToTime(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function timeToMins(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function PreferencesPanel() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/preferences")
      .then((r) => r.json())
      .then(setPrefs);
  }, []);

  if (!prefs) return <div className="panel">Loading preferences…</div>;

  function patch(p: Partial<Prefs>) {
    setPrefs((prev) => (prev ? { ...prev, ...p } : prev));
  }

  async function save() {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(idx: number) {
    const bit = 1 << idx;
    patch({ workDaysMask: prefs!.workDaysMask ^ bit });
  }

  return (
    <div className="panel">
      <h2>Preferences</h2>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div>
          <label>Work start</label>
          <input
            type="time"
            value={minsToTime(prefs.workStartMins)}
            onChange={(e) => patch({ workStartMins: timeToMins(e.target.value) })}
          />
        </div>
        <div>
          <label>Work end</label>
          <input
            type="time"
            value={minsToTime(prefs.workEndMins)}
            onChange={(e) => patch({ workEndMins: timeToMins(e.target.value) })}
          />
        </div>
        <div>
          <label>Focus block / day (mins)</label>
          <input
            type="number"
            min={0}
            step={15}
            value={prefs.focusBlockMins}
            onChange={(e) => patch({ focusBlockMins: Number(e.target.value) })}
          />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Work days</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {DAYS.map((d, i) => {
            const on = (prefs.workDaysMask & (1 << i)) !== 0;
            return (
              <button
                key={d}
                className={on ? "" : "secondary"}
                type="button"
                onClick={() => toggleDay(i)}
                style={{ flex: "0 0 auto" }}
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save preferences"}</button>
      </div>
    </div>
  );
}
