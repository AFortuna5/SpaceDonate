import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getOAuthConfig, missingOAuthConfig, buildOAuthRedirectUrl } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  const provider = "youtube" as const;
  const cfg = getOAuthConfig(provider);

  if (!cfg) {
    return NextResponse.redirect(
      new URL(
        `/login.html?oauth_error=${encodeURIComponent(`Provedor OAuth inválido.`)}`,
        req.url
      )
    );
  }

  const missing = missingOAuthConfig(cfg);
  if (missing.length) {
    const message = `⚠️ Configuração incompleta: ${missing.join(", ")} não configuradas no Vercel. Entre em https://vercel.com/afortuna5/space-donate/settings/environment-variables e adicione as variáveis.`;
    return NextResponse.redirect(
      new URL(
        `/login.html?oauth_error=${encodeURIComponent(message)}`,
        req.url
      )
    );
  }

  const state = crypto.randomBytes(24).toString("hex");
  let redirectUrl: string;
  try {
    redirectUrl = buildOAuthRedirectUrl(provider, state, req);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Erro ao configurar OAuth.";
    return NextResponse.redirect(
      new URL(
        `/login.html?oauth_error=${encodeURIComponent(errorMsg)}`,
        req.url
      )
    );
  }

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
