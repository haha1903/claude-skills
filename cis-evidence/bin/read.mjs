#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export async function main(args, load = () => import("../../_iris-shared/index.mjs")) {
  const [command, ...rest] = args;
  if (command !== "lookup" && command !== "snapshots") throw new Error("Use lookup or snapshots");
  const required = ["cluster", "database", "cloud", ...(command === "lookup" ? ["request", "kind"] : ["job", "start", "end"])];
  const optional = command === "lookup" ? ["rows", "sub-request"] : ["rows", "message-length"];
  const { values } = parseArgs({ args: rest, allowPositionals: false,
    options: Object.fromEntries([...required, ...optional].map(name => [name, { type: "string" }])) });
  for (const name of required) if (!values[name]) throw new Error(`Missing --${name}`);
  const options = { cluster: values.cluster, database: values.database, cloud: values.cloud,
    maxRows: values.rows === undefined ? undefined : Number(values.rows) };
  const { cis } = await load();
  return command === "lookup"
    ? cis.getRequestJobs({ ...options, requestId: values.request, kind: values.kind,
      subRequestId: values["sub-request"] === undefined ? undefined : Number(values["sub-request"]) })
    : cis.getJobSnapshots({ ...options, jobId: values.job, start: values.start, end: values.end,
      messageLength: values["message-length"] === undefined ? undefined : Number(values["message-length"]) });
}

export async function run(args, load, output = console) {
  try {
    const result = await main(args, load);
    output.log(JSON.stringify(result, null, 2));
    return [result.mapping, result.job, result.tasks].some(source => source?.status === "unavailable") ? 1 : 0;
  } catch (error) {
    output.error(error.message);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2));
