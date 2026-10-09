import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_AVATAR_RAW_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_BASE64_CHARS = Math.ceil((MAX_AVATAR_RAW_BYTES * 4) / 3);

const patchSchema = z
  .object({
    avatarUrl: z.string().max(MAX_AVATAR_BASE64_CHARS).nullable(),
  })
  .refine((v) => typeof v.avatarUrl === "string", { message: "потрібен avatarUrl" });

function validateDataUrl(dataUrl: string) {
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new ApiError(400, "VALIDATION_ERROR", "avatarUrl має бути base64 data URL зображення");
  const [, mime, base64] = match;
  if (!ALLOWED_MIME.includes(mime)) {
    throw new ApiError(400, "VALIDATION_ERROR", `Непідтримуваний тип зображення. Дозволені: ${ALLOWED_MIME.join(", ")}`);
  }
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_AVATAR_RAW_BYTES) throw new ApiError(400, "VALIDATION_ERROR", "Зображення завелике (макс. 2МБ)");
}

export async function PATCH(req: Request) {
  try {
    const authUser = await requireUser(req);
    const body = patchSchema.parse(await req.json());
    const avatarUrl = body.avatarUrl as string;

    if (avatarUrl === null || avatarUrl === "") {
      const user = await prisma.user.update({
        where: { id: authUser.id },
        data: { avatarUrl: null },
        select: { id: true, avatarUrl: true },
      });
      return ok(req, { user }, { message: "Аватар видалено" });
    }

    validateDataUrl(avatarUrl);

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: { avatarUrl },
      select: { id: true, avatarUrl: true },
    });

    return ok(req, { user }, { message: "Аватар оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
