"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { TaskPanel } from "@/components/TaskPanel";
import { HabitPanel } from "@/components/HabitPanel";
import { PreferencesPanel } from "@/components/PreferencesPanel";
import { SchedulePanel } from "@/components/SchedulePanel";

export default function Home() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="container">Loading…</div>;
  }

  if (!session) {
    return (
      <div className="container">
        <div className="header">
          <div className="brand">Reclaim</div>
        </div>
        <div className="panel">
          <h2>Sign in</h2>
          <p className="muted">
            Connect your Google Calendar so Reclaim can read your busy times and write auto-scheduled blocks.
          </p>
          <button onClick={() => signIn("google")}>Sign in with Google</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="header">
        <div className="brand">Reclaim</div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <span className="muted">{session.user?.email}</span>
          <button className="secondary" onClick={() => signOut()}>Sign out</button>
        </div>
      </div>

      <div className="stack-lg">
        <SchedulePanel />
        <div className="grid">
          <TaskPanel />
          <HabitPanel />
        </div>
        <PreferencesPanel />
      </div>
    </div>
  );
}
