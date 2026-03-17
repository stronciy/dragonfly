import { ApiError } from "../errors";

export function requireRole(user: { role: string }, role: "customer" | "performer" | "admin") {
  if (user.role !== role) throw new ApiError(403, "FORBIDDEN", `${role} role required`);
}

export function requireAnyRole(user: { role: string }, roles: Array<"customer" | "performer" | "admin">) {
  if (!roles.includes(user.role as any)) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
}
