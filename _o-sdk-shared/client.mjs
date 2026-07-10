/**
 * Shared bootstrap for o-* skills. Imports the compiled iris SDK,
 * auto-builds if needed, returns an Agent365Client instance.
 *
 *   import { openClient } from "../../_o-sdk-shared/client.mjs";
 *   const c = await openClient();
 *   const mail = await c.mail();
 *   ...
 *   await c.close();
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const SDK_ROOT = "/Users/haichang/Projects/iris";
const SDK_ENTRY = path.join(SDK_ROOT, "dist/index.js");

export async function openClient() {
  if (!existsSync(SDK_ENTRY)) {
    console.error("iris SDK not built. Building now…");
    const r = spawnSync("npm", ["run", "build"], { cwd: SDK_ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error("SDK build failed");
  }
  const mod = await import(pathToFileURL(SDK_ENTRY).href);
  return new mod.Agent365Client();
}

export function todayBounds() {
  const now = new Date();
  const s = new Date(now); s.setHours(0, 0, 0, 0);
  const e = new Date(now); e.setHours(23, 59, 59, 999);
  return { startISO: s.toISOString(), endISO: e.toISOString() };
}
export function isoDaysAgo(days) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString();
}
export function fmtTime(iso) {
  return (iso ?? "").slice(0, 16).replace("T", " ");
}
