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
    // HELO/EHLO name. Defaults to the local container hostname, which often
    // fails SPF/PTR checks; use the public mail hostname instead.
    name: process.env.SMTP_HELO_NAME ?? process.env.SMTP_HOST,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Дефолты nodemailer — 2 мин на соединение и 10 мин на простаивающий сокет.
    // Для запроса из админки/восстановления пароля это выглядит как зависание.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
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

/** Настроен ли SMTP (панель показывает это администратору до отправки). */
export function isEmailConfigured(): boolean {
  return isSmtpConfigured();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Письмо от администратора пользователю (связаться по заказу).
 * В отличие от кода восстановления, ошибку не глотаем: администратор должен
 * видеть, что письмо не ушло.
 */
export async function sendAdminMessageEmail(args: {
  to: string;
  title: string;
  message: string;
}): Promise<void> {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP не налаштовано");
  }

  const text = [args.title, "", args.message, "", "— Dragonfly"].join("\n");
  const html = `<!doctype html>
<html lang="uk">
  <body style="margin:0;background:#fafafa;font-family:Arial,Helvetica,sans-serif;color:#18181b">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700">${escapeHtml(args.title)}</h1>
      <p style="margin:0 0 16px;font-size:15px;white-space:pre-line">${escapeHtml(args.message)}</p>
      <p style="margin:0;font-size:14px;color:#52525b">— Dragonfly</p>
    </div>
  </body>
</html>`;

  await buildTransport().sendMail({
    from: process.env.MAIL_FROM,
    to: args.to,
    subject: args.title,
    text,
    html,
  });
}

/**
 * Код восстановления пароля именно для админ-панели.
 *
 * В отличие от пользовательского кода, ошибку отправки не глотаем: если SMTP
 * не настроен или письмо не ушло, восстановление войти не поможет — панель
 * должна показать понятную ошибку администратору.
 */
export type EmailSendResult = {
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
};

export async function sendAdminPasswordResetCode(
  email: string,
  code: string
): Promise<EmailSendResult> {
  if (!isSmtpConfigured()) {
    console.error(
      "[email] admin-reset: SMTP is not configured; refusing to send code",
      JSON.stringify({
        to: email,
        requiredKeys: REQUIRED_SMTP_KEYS,
        missingKeys: REQUIRED_SMTP_KEYS.filter((key) => !process.env[key]),
      })
    );
    throw new Error("SMTP не налаштовано");
  }

  const text = [
    "Dragonfly Admin — код відновлення пароля",
    "",
    `Ваш код для входу в адмін-панель: ${code}`,
    "Код дійсний 15 хвилин.",
    "",
    "Якщо ви не запитували відновлення пароля, просто проігноруйте цей лист.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="uk">
  <body style="margin:0;background:#fafafa;font-family:Arial,Helvetica,sans-serif;color:#18181b">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700">Dragonfly Admin</h1>
      <p style="margin:0 0 8px;font-size:15px">Код для входу в адмін-панель:</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
      <p style="margin:0 0 8px;font-size:14px;color:#52525b">Код дійсний 15 хвилин.</p>
      <p style="margin:0;font-size:14px;color:#52525b">Якщо ви не запитували відновлення пароля, просто проігноруйте цей лист.</p>
    </div>
  </body>
</html>`;

  const transport = buildTransport();
  const from = process.env.MAIL_FROM;
  const subject = "Dragonfly Admin — код відновлення пароля";

  console.info(
    "[email] admin-reset: sending code email",
    JSON.stringify({
      to: email,
      from,
      subject,
      smtpHost: process.env.SMTP_HOST,
      smtpPort: Number(process.env.SMTP_PORT ?? 587),
      smtpSecure: process.env.SMTP_SECURE === "true",
      smtpHeloName: process.env.SMTP_HELO_NAME ?? process.env.SMTP_HOST,
    })
  );

  try {
    const info = await transport.sendMail({
      from,
      to: email,
      subject,
      text,
      html,
    });

    const result: EmailSendResult = {
      messageId: info.messageId,
      accepted: info.accepted as string[] | undefined,
      rejected: info.rejected as string[] | undefined,
      response: info.response,
    };

    console.info(
      "[email] admin-reset: code email accepted by SMTP",
      JSON.stringify({ to: email, ...result })
    );

    if (result.rejected && result.rejected.length > 0) {
      console.error(
        "[email] admin-reset: SMTP rejected recipient",
        JSON.stringify({ to: email, rejected: result.rejected, response: result.response })
      );
    }

    return result;
  } catch (err) {
    console.error(
      "[email] admin-reset: code email failed",
      JSON.stringify({
        to: email,
        name: err instanceof Error ? err.name : "UnknownError",
        message: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string } | null)?.code,
        command: (err as { command?: string } | null)?.command,
        responseCode: (err as { responseCode?: number } | null)?.responseCode,
        response: (err as { response?: string } | null)?.response,
      })
    );
    throw err;
  }
}
