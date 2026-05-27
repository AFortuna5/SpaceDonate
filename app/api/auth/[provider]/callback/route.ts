import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { signAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOAuthConfig, exchangeCodeForToken, fetchProviderProfile, buildRedirectUrl, OAuthProfile } from "@/lib/oauth";

function normalizeCreatorName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "user";
}

async function findOrCreateUser(profile: OAuthProfile) {
  const email = profile.email;
  let user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    return user;
  }

  const baseName = normalizeCreatorName(profile.login || profile.displayName || profile.providerId || "user");
  let creatorName = baseName;
  let suffix = 1;

  while (await prisma.user.findUnique({ where: { creatorName } })) {
    creatorName = `${baseName}-${suffix++}`;
  }

  const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10);
  user = await prisma.user.create({
    data: {
      creatorName,
      email,
      passwordHash,
    },
  });

  return user;
}

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.pathname.split("/")[3] as "youtube" | "twitch";
  const cfg = getOAuthConfig(provider);

  if (!cfg) {
    return NextResponse.json({ error: "Provedor OAuth inválido." }, { status: 404 });
  }

  const requestUrl = new URL(req.url);
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const cookieState = req.cookies.get("sd_oauth_state")?.value;

  if (error) {
    return NextResponse.redirect(
      buildRedirectUrl(
        "/login.html",
        req,
        `${cfg.name}: autorização cancelada ou negada.`
      )
    );
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(
      buildRedirectUrl(
        "/login.html",
        req,
        `${cfg.name}: estado OAuth inválido. Tente novamente.`
      )
    );
  }

  try {
    const redirectUri =
      process.env[provider === "youtube" ? "YOUTUBE_REDIRECT_URI" : "TWITCH_REDIRECT_URI"] ||
      `${new URL(req.url).origin}/auth/${provider}/callback`;
    const token = await exchangeCodeForToken(provider, code, redirectUri);
    const profile = await fetchProviderProfile(provider, token);
    const user = await findOrCreateUser(profile);

    const authToken = signAuthToken({ id: user.id, email: user.email });
    const response = NextResponse.redirect(new URL(`/dashboard.html?connected=${provider}`, req.url));
    response.cookies.set("token", authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    response.cookies.delete("sd_oauth_state");
    return response;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Falha ao concluir conexão OAuth.";
    const response = NextResponse.redirect(
      buildRedirectUrl(
        "/login.html",
        req,
        `${cfg.name}: ${errorMessage}`
      )
    );
    response.cookies.delete("sd_oauth_state");
    return response;
  }
}
