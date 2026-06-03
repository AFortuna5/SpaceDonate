export type OAuthProvider = "youtube" | "twitch";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export function getOAuthConfig(provider: OAuthProvider): OAuthConfig | null {
  if (provider === "youtube") {
    return {
      clientId: process.env.YOUTUBE_CLIENT_ID || "",
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    };
  }

  if (provider === "twitch") {
    return {
      clientId: process.env.TWITCH_CLIENT_ID || "",
      clientSecret: process.env.TWITCH_CLIENT_SECRET || "",
      authUrl: "https://id.twitch.tv/oauth2/authorize",
      tokenUrl: "https://id.twitch.tv/oauth2/token",
      scopes: ["user:read:email"],
    };
  }

  return null;
}

export function missingOAuthConfig(cfg: OAuthConfig) {
  const missing: string[] = [];

  if (!cfg.clientId) missing.push("CLIENT_ID");
  if (!cfg.clientSecret) missing.push("CLIENT_SECRET");

  return missing;
}

export function buildOAuthRedirectUrl(
  provider: OAuthProvider,
  state: string,
  req: Request
) {
  const cfg = getOAuthConfig(provider);

  if (!cfg) {
    throw new Error("OAuth provider inválido.");
  }

  const origin = new URL(req.url).origin;

  const redirectUri = `${origin}/api/auth/${provider}/callback`;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
  });

  return `${cfg.authUrl}?${params.toString()}`;
}