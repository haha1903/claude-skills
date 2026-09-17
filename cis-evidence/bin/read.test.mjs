import { test } from "node:test";
import assert from "node:assert/strict";
import { main, run } from "./read.mjs";

const common = ["--cluster", "https://example.kusto.windows.net", "--database", "example", "--cloud", "Public"];
const lookup = ["lookup", ...common, "--request", "11315072", "--kind", "planned-quota"];
const snapshots = ["snapshots", ...common, "--job", "full-job-id", "--start", "2026-09-15T20:30:00Z", "--end", "2026-09-15T21:00:00Z"];
const load = async () => ({ cis: { getRequestJobs: async input => input, getJobSnapshots: async input => input } });

test("lookup forwards the request flow, optional child and limits to Iris", async () => {
  const input = await main([...lookup, "--sub-request", "2", "--rows", "5"], load);
  assert.equal(input.requestId, "11315072");
  assert.equal(input.kind, "planned-quota");
  assert.equal(input.subRequestId, 2);
  assert.equal(input.maxRows, 5);
  assert.equal(input.cloud, "Public");
  assert.equal((await main(lookup, load)).subRequestId, undefined);
});

test("snapshot mode forwards exact identifiers, bounds and optional message limit", async () => {
  const input = await main([...snapshots, "--message-length", "500"], load);
  assert.equal(input.jobId, "full-job-id");
  assert.equal(input.messageLength, 500);
  assert.equal(input.start, "2026-09-15T20:30:00Z");
  assert.equal((await main(snapshots, load)).messageLength, undefined);
});

test("missing arguments and mixed modes fail before loading Iris", async () => {
  for (const input of [[], ["unknown"], ["lookup"], [...lookup, "--job", "wrong-mode"], [...snapshots, "--request", "1"], [...lookup, "extra"]]) {
    await assert.rejects(main(input, async () => assert.fail("Invalid arguments loaded Iris")));
  }
});

test("unavailable sources fail the command while preserving JSON partial evidence", async () => {
  for (const status of ["ok", "empty", "unavailable"]) {
    const result = { job: { status }, tasks: { status: "ok", rows: [{ StateName: "Blocked" }] } };
    const code = await run(snapshots, async () => ({ cis: { getJobSnapshots: async () => result } }), {
      log: value => assert.deepEqual(JSON.parse(value), result), error: assert.fail,
    });
    assert.equal(code, status === "unavailable" ? 1 : 0);
  }
  let message;
  assert.equal(await run([], load, { log: assert.fail, error: value => { message = value; } }), 2);
  assert.equal(message, "Use lookup or snapshots");
});

test("the CLI entrypoint executes through the container's skill symlink", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "cis-cli-link-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "dist/index.js"), 'export const lionrock = {}; export const cis = {getRequestJobs: async () => ({mapping:{status:"ok",rows:[{JobId:"full-job-id"}]}})};');
    symlinkSync(fileURLToPath(new URL("../", import.meta.url)), join(dir, "linked-skill"), "dir");
    const result = spawnSync(process.execPath, [join(dir, "linked-skill/bin/read.mjs"), ...lookup], {env:{...process.env,IRIS_ROOT:dir},encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mapping.rows[0].JobId, "full-job-id");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
