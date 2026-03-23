import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { normalizeUAIban, validateEdrpou, validateUAIban } from "@/lib/validators";

const companyNameSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().min(2).max(120)
);

const legalAddressSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().min(5).max(255)
);

const edrpouSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().refine(validateEdrpou, "EDRPOU must be 8-10 digits")
);

const ibanSchema = z.preprocess(
  (v) => (typeof v === "string" ? normalizeUAIban(v) : v),
  z.string().refine(validateUAIban, "Invalid UA IBAN")
);

const patchSchema = z.object({
  companyName: companyNameSchema.nullable(),
  edrpou: edrpouSchema.nullable(),
  iban: ibanSchema.nullable(),
  legalAddress: legalAddressSchema.nullable(),
  vatPayer: z.boolean(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const profile = await prisma.performerProfile.findUnique({
      where: { userId: user.id },
      select: {
        companyName: true,
        companyEdrpou: true,
        iban: true,
        vatPayer: true,
        legalAddress: true,
        updatedAt: true,
      },
    });

    return ok(req, {
      legalProfile: {
        companyName: profile?.companyName ?? null,
        edrpou: profile?.companyEdrpou ?? null,
        iban: profile?.iban ?? null,
        vatPayer: profile?.vatPayer ?? false,
        legalAddress: profile?.legalAddress ?? null,
        updatedAt: profile?.updatedAt?.toISOString() ?? new Date().toISOString(),
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const body = patchSchema.parse(await req.json());

    const profile = await prisma.performerProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        companyName: body.companyName,
        companyEdrpou: body.edrpou,
        iban: body.iban,
        vatPayer: body.vatPayer,
        legalAddress: body.legalAddress,
      },
      update: {
        companyName: body.companyName,
        companyEdrpou: body.edrpou,
        iban: body.iban,
        vatPayer: body.vatPayer,
        legalAddress: body.legalAddress,
      },
      select: {
        companyName: true,
        companyEdrpou: true,
        iban: true,
        vatPayer: true,
        legalAddress: true,
        updatedAt: true,
      },
    });

    return ok(req, {
      legalProfile: {
        companyName: profile.companyName,
        edrpou: profile.companyEdrpou,
        iban: profile.iban,
        vatPayer: profile.vatPayer,
        legalAddress: profile.legalAddress,
        updatedAt: profile.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
