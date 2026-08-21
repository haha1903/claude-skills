/**
 * Shared bootstrap for ops skills (kusto/icm/ev2/boards/...). Loads the iris SDK
 * and re-exports its base/ops + agent365 namespaces.
 *
 * By default it loads a self-contained, vendored bundle (iris.bundle.mjs) next to
 * this file — no ~/Projects/iris checkout or node_modules needed. Set IRIS_ROOT to
 * load a source `dist/` build instead (used by the AKS image and local iris dev).
 * Regenerate the bundle after changing iris: run `npm run bundle:skills` in
 * ~/Projects/iris.
 *
 *   import { kusto } from "../../_iris-shared/index.mjs";
 *   const { cols, rows } = await kusto.queryKusto(cluster, db, kql);
 *
 * Adding a module to iris means TWO edits here, not one: rebundle, AND add the
 * re-export line below. The list is explicit rather than `export * from`, so a module
 * present in the bundle but missing from the list fails at import with "does not
 * provide an export named X" -- which reads like a stale bundle and is not.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const entry = process.env.IRIS_ROOT
  ? pathToFileURL(path.join(process.env.IRIS_ROOT, "dist/index.js")).href
  : new URL("./iris.bundle.mjs", import.meta.url).href;

const mod = await import(entry);
export const auth = mod.auth;
export const azcli = mod.azcli;
export const kusto = mod.kusto;
export const icm = mod.icm;
export const ev2 = mod.ev2;
export const ado = mod.ado;
export const boards = mod.boards;
export const aigen = mod.aigen;
export const geneva = mod.geneva;
export const safefly = mod.safefly;
export const abh = mod.abh;
export const webjobs = mod.webjobs;
export const mcpHttp = mod.mcpHttp;
export const bridge = mod.bridge;
export const log = mod.log;
