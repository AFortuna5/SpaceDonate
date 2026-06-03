import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("token");

    if (!token) {
      return NextResponse.json(
        { error: "Não autenticado." },
        { status: 401 }
      );
    }

    const decoded = jwt.verify(
      token.value,
      process.env.JWT_SECRET || "dev-secret"
    ) as {
      id: string;
      email: string;
    };

    const user = await prisma.user.findUnique({
      where: {
        id: decoded.id,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Usuário não encontrado." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        creatorName: user.creatorName,
        email: user.email,
        createdAt: user.createdAt,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Token inválido." },
      { status: 401 }
    );
  }
}