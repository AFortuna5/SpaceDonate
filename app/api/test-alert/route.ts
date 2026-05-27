import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("[Test Alert]", JSON.stringify(body, null, 2));
    return NextResponse.json({ ok: true, sent: body });
  } catch (error) {
    console.error("[Test Alert]", error);
    return NextResponse.json({ error: "Erro interno do servidor." }, { status: 500 });
  }
}
