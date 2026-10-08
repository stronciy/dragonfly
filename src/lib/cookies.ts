export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return true;
  if (forwarded === "http") return false;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}
