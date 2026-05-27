import { NextResponse } from "next/server";

function normalizeDonation(body: any) {
  return {
    name: String(body.name || "").trim().slice(0, 40),
    amount: roundMoney(Number(body.amount)),
    email: String(body.email || "").trim().slice(0, 120),
    message: String(body.message || "").trim().slice(0, 180),
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function toCents(value: number) {
  return Math.round(value * 100);
}

function escapeSvg(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildQrSvg(donation: { name: string }, amount: number) {
  const label = (amount / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <rect width="220" height="220" fill="white"/>
  <rect x="16" y="16" width="52" height="52" fill="#111"/>
  <rect x="152" y="16" width="52" height="52" fill="#111"/>
  <rect x="16" y="152" width="52" height="52" fill="#111"/>
  <rect x="30" y="30" width="24" height="24" fill="white"/>
  <rect x="166" y="30" width="24" height="24" fill="white"/>
  <rect x="30" y="166" width="24" height="24" fill="white"/>
  <g fill="#111">
    <rect x="88" y="20" width="12" height="12"/><rect x="112" y="20" width="12" height="12"/>
    <rect x="88" y="44" width="36" height="12"/><rect x="84" y="84" width="12" height="12"/>
    <rect x="108" y="84" width="12" height="12"/><rect x="132" y="84" width="36" height="12"/>
    <rect x="84" y="108" width="48" height="12"/><rect x="156" y="108" width="12" height="12"/>
    <rect x="180" y="108" width="12" height="12"/><rect x="84" y="132" width="12" height="12"/>
    <rect x="120" y="132" width="72" height="12"/><rect x="84" y="156" width="48" height="12"/>
    <rect x="156" y="156" width="12" height="36"/><rect x="180" y="180" width="12" height="12"/>
  </g>
  <text x="110" y="207" text-anchor="middle" font-family="monospace" font-size="9" fill="#555">PIX PLACEHOLDER · ${escapeSvg(label)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const donation = normalizeDonation(body);

    if (!donation.name || !Number.isFinite(donation.amount) || donation.amount < 1) {
      return NextResponse.json(
        { error: "Informe nome e valor mínimo de R$1,00." },
        { status: 400 }
      );
    }

    const id = `placeholder-${Date.now()}`;
    const amount = toCents(donation.amount);
    const brCode = [
      "000201",
      "010212",
      "26PLACEHOLDER-SPACEDONATE",
      `52DONATE-${donation.name.replace(/\s+/g, "-").toUpperCase()}`,
      `54${donation.amount.toFixed(2)}`,
      "5802BR",
      "5909PLACEHOLDER",
      "6009SAO PAULO",
      `62${id}`,
      "6304FAKE",
    ].join("");

    return NextResponse.json({
      id,
      amount,
      status: "PENDING_PLACEHOLDER",
      brCode,
      brCodeBase64: buildQrSvg(donation, amount),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Erro interno do servidor." },
      { status: 500 }
    );
  }
}
