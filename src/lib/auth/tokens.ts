import { SignJWT, jwtVerify } from "jose";

type AccessTokenPayload = {
  userId: string;
  email: string;
  role: "customer" | "performer" | "admin";
};

type RefreshTokenPayload = {
  userId: string;
  jti: string;
};

function getSecret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new TextEncoder().encode(value);
}

export async function signAccessToken(payload: AccessTokenPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(getSecret("JWT_ACCESS_SECRET"));
}

export async function signRefreshToken(payload: RefreshTokenPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret("JWT_REFRESH_SECRET"));
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify<AccessTokenPayload>(token, getSecret("JWT_ACCESS_SECRET"));
  return payload;
}

export async function verifyRefreshToken(token: string) {
  const { payload } = await jwtVerify<RefreshTokenPayload>(token, getSecret("JWT_REFRESH_SECRET"));
  return payload;
}

export async function sha256(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}
