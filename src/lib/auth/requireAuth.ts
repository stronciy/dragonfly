import { prisma } from "@/shared";
import { ApiError } from "@/shared";
import { verifyAccessToken } from "./tokens";

export async function requireUser(req: Request) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHORIZED", "Відсутній токен доступу");

  const token = auth.slice("Bearer ".length).trim();
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "Відсутній токен доступу");

  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Недійсний токен доступу");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, name: true, email: true, role: true, phone: true, avatarUrl: true, createdAt: true },
  });

  if (!user) throw new ApiError(401, "UNAUTHORIZED", "Користувача не знайдено");

  return user;
}
