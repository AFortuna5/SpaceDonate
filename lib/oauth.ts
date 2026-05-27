import { verifyAuthToken } from "@/lib/auth";
import { NextRequest } from "next/server";

export type OAuthProvider = "youtube" | "twitch";

export interface OAuthProfile {
  displayName: string;
  login: string;
  email: string;
  providerId: string;
}

interface OAuthConfig {
  name: string;
  clientId?: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
}

const providers: Record<OAuthProvider, OAuthConfig> = {
  youtube: {
    name: "YouTube",
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile https://www.googleapis.com/auth/youtube.readonly",
  },
  twitch: {
    name: "Twitch",
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    authUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    scope: "user:read:email",
  },
};

export function getOAuthConfig(provider: string) {
  if (provider !== "youtube" && provider !== "twitch") {
    return null;
  }
  return providers[provider];
}

export function getBaseUrl(request: NextRequest) {
  return process.env.PUBLIC_BASE_URL || new URL(request.url).origin;
}

export function getRedirectUri(provider: OAuthProvider, request: NextRequest) {
  const origin = getBaseUrl(request);
  return process.env[
    provider === "youtube" ? "YOUTUBE_REDIRECT_URI" : "TWITCH_REDIRECT_URI"
  ] || `${origin}/auth/${provider}/callback`;
}

export function missingOAuthConfig(cfg: OAuthConfig) {
  const missing: string[] = [];
  if (!cfg.clientId) missing.push(`${cfg.name.toUpperCase()}_CLIENT_ID`);
  if (!cfg.clientSecret) missing.push(`${cfg.name.toUpperCase()}_CLIENT_SECRET`);
  return missing;
}

export function getAuthenticatedUser(request: NextRequest) {
  const token = request.cookies.get("token")?.value;
  if (!token) return null;

  try {
    return verifyAuthToken(token);
  } catch {
    return null;
  }
}

export async function exchangeCodeForToken(provider: OAuthProvider, code: string, redirectUri: string) {
  const cfg = getOAuthConfig(provider);
  if (!cfg) throw new Error("Provider inválido.");

  const body = new URLSearchParams({
    client_id: cfg.clientId || "",
    client_secret: cfg.clientSecret || "",
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Token HTTP ${response.status}`);
  }

  return data as { access_token: string; refresh_token?: string; expires_in?: number };
}

export async function fetchProviderProfile(provider: OAuthProvider, token: { access_token: string }) {
  if (provider === "youtube") {
    const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    });
    const userInfo = await userInfoResponse.json().catch(() => ({}));
    if (!userInfoResponse.ok) {
      throw new Error(userInfo.error_description || userInfo.error || `YouTube userinfo HTTP ${userInfoResponse.status}`);
    }

    const response = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `YouTube profile HTTP ${response.status}`);
    const channel = data.items?.[0] || {};

    return {
      displayName: channel.snippet?.title || userInfo.name || "Canal YouTube",
      login: userInfo.email?.split("@")[0] || channel.snippet?.title?.replace(/\s+/g, "").toLowerCase() || "youtube",
      email: userInfo.email || `youtube-${channel.id || userInfo.sub || "unknown"}@spacedonate.local`,
      providerId: channel.id || userInfo.sub || "",
    };
  }

  const twitchResponse = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Client-Id": providers.twitch.clientId || "",
    },
  });
  const twitchData = await twitchResponse.json().catch(() => ({}));
  if (!twitchResponse.ok) throw new Error(twitchData.message || `Twitch profile HTTP ${twitchResponse.status}`);
  const user = twitchData.data?.[0] || {};

  return {
    displayName: user.display_name || user.login || "Canal Twitch",
    login: user.login || `twitch-${user.id || "unknown"}`,
    email: user.email || `twitch-${user.id || "unknown"}@spacedonate.local`,
    providerId: user.id || "",
  };
}

export function buildOAuthRedirectUrl(provider: OAuthProvider, state: string, request: NextRequest) {
  const cfg = getOAuthConfig(provider);
  if (!cfg) throw new Error("Provider inválido.");

  const redirectUri = getRedirectUri(provider, request);
  const params = new URLSearchParams({
    client_id: cfg.clientId || "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state,
  });

  if (provider === "youtube") {
    params.set("access_type", "offline");
    params.set("include_granted_scopes", "true");
    params.set("prompt", "consent");
  }

  return `${cfg.authUrl}?${params.toString()}`;
}

export function buildRedirectUrl(path: string, request: NextRequest, error?: string) {
  const url = new URL(path, request.url);
  if (error) {
    url.searchParams.set("oauth_error", error);
  }
  return url;
}
