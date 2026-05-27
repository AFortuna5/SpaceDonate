import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  try {
    const user = getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    }

    return NextResponse.json({
      youtube: { connected: false },
      twitch: { connected: false },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Erro interno do servidor." }, { status: 500 });
  }
}
