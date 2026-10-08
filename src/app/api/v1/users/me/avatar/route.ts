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
  .refine((v) => typeof v.avatarUrl === "string", { message: "avatarUrl required" });

function validateDataUrl(dataUrl: string) {
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new ApiError(400, "VALIDATION_ERROR", "avatarUrl must be a base64 image data URL");
  const [, mime, base64] = match;
  if (!ALLOWED_MIME.includes(mime)) {
    throw new ApiError(400, "VALIDATION_ERROR", `Unsupported image type. Allowed: ${ALLOWED_MIME.join(", ")}`);
  }
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_AVATAR_RAW_BYTES) throw new ApiError(400, "VALIDATION_ERROR", "Image too large (max 2MB)");
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
      return ok(req, { user }, { message: "Avatar removed" });
    }

    validateDataUrl(avatarUrl);

    const user = await prisma.user.update({
      where: { id: authUser.id },
      data: { avatarUrl },
      select: { id: true, avatarUrl: true },
    });

    return ok(req, { user }, { message: "Avatar updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
