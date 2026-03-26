import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    areaHa: z.number().positive().optional(),
    addressLabel: z.string().min(1).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    points: z.any().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

async function getOwnedField(userId: string, fieldId: string) {
  const field = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!field || field.ownerUserId !== userId) throw new ApiError(404, "NOT_FOUND", "Field not found");
  return field;
}

export async function GET(req: Request, ctx: { params: Promise<{ fieldId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { fieldId } = await ctx.params;
    const field = await getOwnedField(user.id, fieldId);
    return ok(req, { field });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ fieldId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { fieldId } = await ctx.params;
    await getOwnedField(user.id, fieldId);
    const body = patchSchema.parse(await req.json());

    const field = await prisma.field.update({
      where: { id: fieldId },
      data: {
        name: body.name,
        areaHa: body.areaHa,
        addressLabel: body.addressLabel,
        lat: body.lat,
        lng: body.lng,
        points: body.points,
      },
    });

    return ok(req, { field }, { message: "Updated" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ fieldId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { fieldId } = await ctx.params;
    await getOwnedField(user.id, fieldId);
    await prisma.field.delete({ where: { id: fieldId } });
    return ok(req, {}, { status: 204, message: "Deleted" });
  } catch (err) {
    return fail(req, err);
  }
}
