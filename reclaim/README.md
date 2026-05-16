# Reclaim

A self-hostable "Reclaim AI"-style smart calendar: connect Google Calendar, define
tasks and habits with priorities and deadlines, and let the scheduler auto-place
them around your existing meetings.

## Features

- Google OAuth + Google Calendar integration (read busy, write events)
- Tasks with duration, priority (LOW/MEDIUM/HIGH/URGENT), deadline, and chunk sizes
- Recurring habits with a weekly target and a daily time window
- Working-hours and work-days preferences
- One-click **Preview plan** and **Write to Google Calendar** (idempotent — re-running replaces previous auto-scheduled blocks)

## Stack

- Next.js 14 (App Router) + TypeScript
- NextAuth (Google provider, with calendar scopes)
- Prisma + SQLite (swap for Postgres in production)
- googleapis SDK

## Setup

1. **Install deps**
   ```bash
   npm install
   ```

2. **Configure Google OAuth**
   - Create a project at https://console.cloud.google.com
   - Enable the **Google Calendar API**
   - Create an OAuth 2.0 client (type: Web), add redirect URI:
     `http://localhost:3000/api/auth/callback/google`
   - Copy `.env.example` to `.env` and fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - Generate a NextAuth secret: `openssl rand -base64 32`

3. **Initialize the database**
   ```bash
   npx prisma db push
   ```

4. **Run**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000 and sign in with Google.

## How the scheduler works

`src/lib/scheduler.ts`:

1. Builds free intervals for the next 7 days inside your working hours, minus any
   busy time on your primary calendar.
2. Places habits first into their daily windows, spreading sessions across
   distinct days up to the weekly target.
3. Sorts tasks by priority then deadline, and greedily slots each task into the
   earliest fitting chunk (respecting min/max chunk size and deadline).
4. Returns the assignments plus reasons for anything that couldn't fit.

`POST /api/schedule` is **idempotent**: it deletes previously-written
auto-scheduled events before writing fresh ones, so you can re-run after adding
or completing tasks.

## Limitations / next steps

- Single calendar (`primary`) only. Multi-calendar support is a small extension.
- Greedy scheduler; doesn't backtrack to optimize global packing.
- No timezone-aware UI (uses browser locale); model field is stored but not yet
  applied to scheduling math.
- Focus-block reservation is configurable in preferences but not yet enforced by
  the scheduler.
- No background re-planning. Today re-planning is user-triggered.
