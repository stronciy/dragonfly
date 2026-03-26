import { ok, fail } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth/requireAuth";
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

    return ok(req, {
      setup: {
        otpauthUrl,
        secret,
        qrCodeSvg,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
