import jwt from "jsonwebtoken";

export interface AuthTokenPayload {
  id: string;
  email: string;
}

const secret = process.env.JWT_SECRET || "dev-secret";

export function signAuthToken(payload: AuthTokenPayload) {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string) {
  return jwt.verify(token, secret) as AuthTokenPayload;
}
