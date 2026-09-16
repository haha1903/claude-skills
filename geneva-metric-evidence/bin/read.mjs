#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export async function main(args, load = () => import("../../_iris-shared/index.mjs")) {
  const [mode, ...rest] = args;
  if (!["monitors", "series"].includes(mode)) throw new Error("Choose monitors or series");
  const { values: v } = parseArgs({ args: rest, options: Object.fromEntries(["account", "stamp", "cert", "key", "namespace", "metric", "dimensions", "filters", "sampling", "start", "end"].map(k => [k, { type: "string" }])), allowPositionals: false });
  const common = { account: v.account ?? "agboa", certPath: v.cert ?? process.env.GENEVA_METRICS_CERT ?? path.join(homedir(), ".bet/certs/int/geneva-log.crt"), keyPath: v.key ?? process.env.GENEVA_METRICS_KEY ?? path.join(homedir(), ".bet/certs/int/geneva-log.key") };
  if (mode === "series") for (const key of ["namespace", "metric", "dimensions", "start", "end"]) if (!v[key]) throw new Error(`Missing --${key}`);
  const { genevaMetrics } = await load();
  return mode === "monitors"
    ? genevaMetrics.readMonitorConfigs({ ...common, stamp: v.stamp ?? "https://prod5.prod.microsoftmetrics.com" })
    : genevaMetrics.readMetricSeries({ ...common, namespace: v.namespace, metric: v.metric, dimensions: v.dimensions.split(","), filters: JSON.parse(v.filters ?? "{}"), samplingTypes: (v.sampling ?? "Count").split(","), start: v.start, end: v.end });
}

export async function run(args, load, output = console) {
  try {
    const result = await main(args, load); output.log(JSON.stringify(result, null, 2));
    return [result, result.v1, result.v2].some(r => ["unavailable", "incomplete"].includes(r?.status)) ? 1 : 0;
  } catch (error) { output.error(error.message); return 2; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
