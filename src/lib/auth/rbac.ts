import { ApiError } from "@/shared";

export function requireRole(user: { role: string }, role: "customer" | "performer" | "admin") {
  if (user.role !== role) throw new ApiError(403, "FORBIDDEN", `потрібна роль: ${role}`);
}

export function requireAnyRole(user: { role: string }, roles: Array<"customer" | "performer" | "admin">) {
  if (!roles.includes(user.role as "customer" | "performer" | "admin")) {
    throw new ApiError(403, "FORBIDDEN", "Недостатньо прав");
  }
}
