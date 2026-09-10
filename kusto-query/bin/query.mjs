#!/usr/bin/env node
/**
 * Run a KQL query (or -mgmt command) against a Kusto cluster via the iris SDK.
 *
 *   query.mjs <cluster_url> <database> <kql>
 *   query.mjs --mgmt <cluster_url> <database> ".show tables"
 */
import { checkQueryAccess } from "../lib/query-policy.mjs";

const args = process.argv.slice(2);
const mgmt = args[0] === "--mgmt";
const [cluster, db, text] = mgmt ? args.slice(1) : args;
if (!cluster || !db || !text) {
  console.error('Usage: query.mjs [--mgmt] <cluster_url> <database> "<kql-or-command>"');
  process.exit(2);
}

checkQueryAccess(mgmt, text, process.env.LOOP_ROLE);
const { kusto } = await import("../../_iris-shared/index.mjs");
const { cols, rows } = mgmt
  ? await kusto.mgmtKusto(cluster, db, text)
  : await kusto.queryKusto(cluster, db, text);

console.log(JSON.stringify({ cols, rows }, null, 2));
