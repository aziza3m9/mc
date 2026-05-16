import { google, calendar_v3 } from "googleapis";
import { prisma } from "./prisma";

export type Busy = { start: Date; end: Date };

async function oauthClientForUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.accessToken) throw new Error("User has no Google access token");

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken ?? undefined,
    expiry_date: user.tokenExpires?.getTime(),
  });

  // Persist refreshed credentials when google rotates them.
  oauth2.on("tokens", async (tokens) => {
    await prisma.user.update({
      where: { id: userId },
      data: {
        accessToken: tokens.access_token ?? user.accessToken,
        refreshToken: tokens.refresh_token ?? user.refreshToken,
        tokenExpires: tokens.expiry_date ? new Date(tokens.expiry_date) : user.tokenExpires,
      },
    });
  });

  return oauth2;
}

export async function getCalendar(userId: string) {
  const auth = await oauthClientForUser(userId);
  return google.calendar({ version: "v3", auth });
}

export async function getBusy(userId: string, timeMin: Date, timeMax: Date): Promise<Busy[]> {
  const calendar = await getCalendar(userId);
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: "primary" }],
    },
  });
  const busy = res.data.calendars?.primary?.busy ?? [];
  return busy
    .filter((b): b is calendar_v3.Schema$TimePeriod & { start: string; end: string } =>
      Boolean(b.start && b.end),
    )
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function createEvent(
  userId: string,
  opts: { summary: string; description?: string; start: Date; end: Date },
) {
  const calendar = await getCalendar(userId);
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.start.toISOString() },
      end: { dateTime: opts.end.toISOString() },
    },
  });
  return res.data;
}

export async function deleteEvent(userId: string, eventId: string) {
  const calendar = await getCalendar(userId);
  await calendar.events.delete({ calendarId: "primary", eventId });
}
