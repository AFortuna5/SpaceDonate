import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getOAuthConfig, missingOAuthConfig, buildOAuthRedirectUrl } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.pathname.split("/")[3] as "youtube" | "twitch";
  const cfg = getOAuthConfig(provider);

  if (!cfg) {
    return NextResponse.json({ error: "Provedor OAuth inválido." }, { status: 404 });
  }

  const missing = missingOAuthConfig(cfg);
  if (missing.length) {
    return NextResponse.redirect(
      new URL(
        `/login.html?oauth_error=${encodeURIComponent(`Configure ${missing.join(", ")} no .env antes de conectar ${cfg.name}.`)}`,
        req.url
      )
    );
  }

  const state = crypto.randomBytes(24).toString("hex");
  const redirectUrl = buildOAuthRedirectUrl(provider, state, req);

  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set("sd_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
