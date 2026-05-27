
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@/lib/prisma";

function createAuthToken(user: { id: string; email: string }) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "7d" }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { creatorName, email, password } = body;

    if (!creatorName || !email || !password) {
      return NextResponse.json(
        { error: "Preencha todos os campos." },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { creatorName }],
      },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "Usuário já existe." },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        creatorName,
        email,
        passwordHash,
      },
    });

    const token = createAuthToken({ id: user.id, email: user.email });
    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        creatorName: user.creatorName,
        email: user.email,
      },
    });

    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return response;
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Erro interno do servidor." },
      { status: 500 }
    );
  }
}
