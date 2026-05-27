import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("[AbacatePay Webhook]", JSON.stringify(body, null, 2));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[AbacatePay Webhook]", error);
    return NextResponse.json({ error: "Erro interno do servidor." }, { status: 500 });
  }
}
