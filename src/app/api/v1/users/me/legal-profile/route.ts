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
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
  z.string().min(5).max(255).nullable()
);

const edrpouSchema = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
  z.string().refine(validateEdrpou, "EDRPOU must be 8-10 digits").nullable()
);

const ibanSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    if (trimmed === "") return null;
    return normalizeUAIban(trimmed);
  },
  z.string().refine(validateUAIban, "Invalid UA IBAN").nullable()
);

const patchSchema = z.object({
  companyName: companyNameSchema.nullable().optional(),
  edrpou: edrpouSchema.nullable().optional(),
  iban: ibanSchema.nullable().optional(),
  legalAddress: legalAddressSchema.nullable().optional(),
  vatPayer: z.boolean().optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);

    const legalProfile = await prisma.legalProfile.findUnique({
      where: { userId: user.id },
      select: {
        companyName: true,
        edrpou: true,
        iban: true,
        vatPayer: true,
        legalAddress: true,
        updatedAt: true,
      },
    });

    return ok(req, {
      legalProfile: {
        companyName: legalProfile?.companyName ?? null,
        edrpou: legalProfile?.edrpou ?? null,
        iban: legalProfile?.iban ?? null,
        vatPayer: legalProfile?.vatPayer ?? false,
        legalAddress: legalProfile?.legalAddress ?? null,
        updatedAt: legalProfile?.updatedAt?.toISOString() ?? new Date().toISOString(),
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);

    const body = patchSchema.parse(await req.json());

    // Получаем текущий профиль для частичного обновления
    const current = await prisma.legalProfile.findUnique({
      where: { userId: user.id },
      select: {
        companyName: true,
        edrpou: true,
        iban: true,
        vatPayer: true,
        legalAddress: true,
      },
    });

    const profile = await prisma.legalProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        companyName: body.companyName ?? null,
        edrpou: body.edrpou ?? null,
        iban: body.iban ?? null,
        vatPayer: body.vatPayer ?? false,
        legalAddress: body.legalAddress ?? null,
      },
      update: {
        companyName: body.companyName !== undefined ? body.companyName : current?.companyName,
        edrpou: body.edrpou !== undefined ? body.edrpou : current?.edrpou,
        iban: body.iban !== undefined ? body.iban : current?.iban,
        vatPayer: body.vatPayer !== undefined ? body.vatPayer : current?.vatPayer,
        legalAddress: body.legalAddress !== undefined ? body.legalAddress : current?.legalAddress,
      },
      select: {
        companyName: true,
        edrpou: true,
        iban: true,
        vatPayer: true,
        legalAddress: true,
        updatedAt: true,
      },
    });

    return ok(req, {
      legalProfile: {
        companyName: profile.companyName,
        edrpou: profile.edrpou,
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
