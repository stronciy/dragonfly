import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { generateSecret, generateURI } from "otplib";
import QRCode from "qrcode";

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const secret = generateSecret();
    const issuer = "Dragonfly";
    const label = user.email;
    const otpauthUrl = generateURI({ secret, label, issuer, algorithm: "sha1", digits: 6, period: 30 });
    const qrCodeSvg = await QRCode.toString(otpauthUrl, { type: "svg" });
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const setup = await prisma.twoFactorSetup.create({
      data: { userId: user.id, secret, expiresAt },
      select: { id: true },
    });

    return ok(req, {
      setup: {
        otpauthUrl,
        secret,
        qrCodeSvg,
        setupId: setup.id,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
