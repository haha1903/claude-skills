#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export async function main(args, load = () => import("../../_iris-shared/index.mjs")) {
  const { values } = parseArgs({ args, options: Object.fromEntries([
    "cluster", "database", "start", "end", "activity", "execution", "operation-url", "rows", "message-length",
  ].map(name => [name, { type: "string" }])), allowPositionals: false });
  for (const name of ["cluster", "database", "start", "end"]) {
    if (!values[name]) throw new Error(`Missing --${name}`);
  }
  if ([values.activity, values.execution, values["operation-url"]].filter(Boolean).length !== 1) {
    throw new Error("Supply exactly one --activity, --execution or --operation-url");
  }
  const { genevaLogs } = await load();
  return genevaLogs.getExecutionLogs({
    cluster: values.cluster, database: values.database, start: values.start, end: values.end,
    activityId: values.activity,
    executionId: values["operation-url"] ? genevaLogs.executionIdFromUrl(values["operation-url"]) : values.execution,
    maxRows: values.rows === undefined ? undefined : Number(values.rows),
    messageLength: values["message-length"] === undefined ? undefined : Number(values["message-length"]),
  });
}

export async function run(args, load, output = console) {
  try {
    const result = await main(args, load);
    output.log(JSON.stringify(result, null, 2));
    return [result.discovery, result.audit, result.tracing].some(source => source?.status === "unavailable") ? 1 : 0;
  } catch (error) {
    output.error(error.message);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
