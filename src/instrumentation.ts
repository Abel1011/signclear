export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __sweeper?: NodeJS.Timeout };
  if (g.__sweeper) return;
  const { sweepAll } = await import("./lib/engine");
  const { ensurePragmas } = await import("./lib/db");
  await ensurePragmas();
  sweepAll().catch((e) => console.error("startup sweep", e));
  g.__sweeper = setInterval(() => sweepAll().catch((e) => console.error("sweep", e)), 60_000);
}
