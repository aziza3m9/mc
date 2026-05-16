import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "./prisma";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.tokenExpires = account.expires_at
          ? account.expires_at * 1000
          : undefined;

        const email = (profile as { email?: string } | undefined)?.email ?? token.email;
        if (email) {
          const user = await prisma.user.upsert({
            where: { email },
            update: {
              accessToken: account.access_token,
              refreshToken: account.refresh_token ?? undefined,
              tokenExpires: account.expires_at
                ? new Date(account.expires_at * 1000)
                : undefined,
              name: token.name ?? undefined,
              image: token.picture ?? undefined,
            },
            create: {
              email,
              name: token.name ?? null,
              image: token.picture ?? null,
              accessToken: account.access_token,
              refreshToken: account.refresh_token ?? null,
              tokenExpires: account.expires_at
                ? new Date(account.expires_at * 1000)
                : null,
              preferences: { create: {} },
            },
          });
          token.userId = user.id;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.userId as string | undefined;
      }
      return session;
    },
  },
};
