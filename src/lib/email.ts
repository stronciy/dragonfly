import nodemailer from "nodemailer";

const REQUIRED_SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] as const;

function isSmtpConfigured() {
  return REQUIRED_SMTP_KEYS.every((key) => Boolean(process.env[key]));
}

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendPasswordResetCode(email: string, code: string): Promise<void> {
  if (!isSmtpConfigured()) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[email] SMTP не налаштовано — код відновлення для ${email}: ${code}`);
    } else {
      console.error("[email] SMTP не налаштовано — лист відновлення пароля не надіслано");
    }
    return;
  }

  const text = [
    "Dragonfly — код відновлення пароля",
    "",
    `Ваш код відновлення: ${code}`,
    "Код дійсний 15 хвилин.",
    "",
    "Якщо ви не запитували відновлення пароля, просто проігноруйте цей лист.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="uk">
  <body style="margin:0;background:#fafafa;font-family:Arial,Helvetica,sans-serif;color:#18181b">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700">Dragonfly</h1>
      <p style="margin:0 0 8px;font-size:15px">Код відновлення пароля:</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
      <p style="margin:0 0 8px;font-size:14px;color:#52525b">Код дійсний 15 хвилин.</p>
      <p style="margin:0;font-size:14px;color:#52525b">Якщо ви не запитували відновлення пароля, просто проігноруйте цей лист.</p>
    </div>
  </body>
</html>`;

  try {
    await buildTransport().sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "Dragonfly — код відновлення пароля",
      text,
      html,
    });
  } catch (err) {
    console.error(
      "[email] Не вдалося надіслати лист відновлення пароля:",
      err instanceof Error ? err.message : err
    );
  }
}
