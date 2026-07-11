/**
 * Shared bootstrap for ops skills (kusto/icm/ev2/...). Imports the compiled iris
 * SDK, auto-builds if needed, and re-exports its base/ops namespaces. Mirrors
 * _o-sdk-shared/client.mjs, but exposes the flat modules rather than an
 * Agent365Client.
 *
 *   import { kusto } from "../../_iris-shared/index.mjs";
 *   const { cols, rows } = await kusto.queryKusto(cluster, db, kql);
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const SDK_ROOT = "/Users/haichang/Projects/iris";
const SDK_ENTRY = path.join(SDK_ROOT, "dist/index.js");

if (!existsSync(SDK_ENTRY)) {
  console.error("iris SDK not built. Building now…");
  const r = spawnSync("npm", ["run", "build"], { cwd: SDK_ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error("iris SDK build failed");
}

const mod = await import(pathToFileURL(SDK_ENTRY).href);
export const auth = mod.auth;
export const azcli = mod.azcli;
export const kusto = mod.kusto;
export const icm = mod.icm;
export const ev2 = mod.ev2;
export const ado = mod.ado;
export const boards = mod.boards;
export const aigen = mod.aigen;
export const geneva = mod.geneva;
export const bridge = mod.bridge;
export const log = mod.log;
