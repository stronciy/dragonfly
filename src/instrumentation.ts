export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAdminEventPoller } = await import("@/lib/adminNotifications/poller");
  startAdminEventPoller();
}
