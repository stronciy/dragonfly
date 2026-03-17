import { prisma } from "../prisma";
import { ApiError } from "../errors";
import { verifyAccessToken } from "./tokens";

export async function requireUser(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHORIZED", "Missing access token");

  const token = auth.slice("Bearer ".length).trim();
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "Missing access token");

  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid access token");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, name: true, email: true, role: true, phone: true, createdAt: true },
  });

  if (!user) throw new ApiError(401, "UNAUTHORIZED", "User not found");

  return user;
}
