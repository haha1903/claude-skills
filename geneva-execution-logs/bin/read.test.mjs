import { test } from "node:test";
import assert from "node:assert/strict";
import { main, run } from "./read.mjs";

const args = ["--cluster", "https://example.kusto.windows.net", "--database", "Production", "--start", "2026-09-15T17:20:00Z", "--end", "2026-09-15T17:35:00Z"];
const load = async () => ({ genevaLogs: { getExecutionLogs: async input => input, executionIdFromUrl: value => `parsed:${value}` } });

test("CLI forwards a bounded execution lookup to Iris without assembling API calls", async () => {
  const result = await main([...args, "--execution", "exact-key", "--rows", "40", "--message-length", "1000"], load);
  assert.equal(result.executionId, "exact-key");
  assert.equal(result.maxRows, 40);
  assert.equal(result.messageLength, 1000);
  assert.equal(result.database, "Production");
});

test("CLI supports an exact activity or delegates URL parsing to Iris", async () => {
  assert.equal((await main([...args, "--activity", "activity-guid"], load)).activityId, "activity-guid");
  assert.equal((await main([...args, "--operation-url", "https://operation"], load)).executionId, "parsed:https://operation");
});

test("missing bounds, ambiguous selectors and unknown options fail before loading credentials", async () => {
  for (const input of [[], args, [...args, "--activity", "a", "--execution", "b"], [...args, "--command", ".drop table Audit"]]) {
    await assert.rejects(main(input, async () => assert.fail("Invalid input loaded Iris")));
  }
});

test("JSON output preserves partial evidence and distinguishes unavailable from empty", async () => {
  for (const status of ["ok", "empty", "unavailable"]) {
    const result = { audit: { status, rows: [] }, tracing: { status: "ok", rows: [{ TraceMessage: "failure" }] } };
    const output = { log: value => assert.deepEqual(JSON.parse(value), result), error: assert.fail };
    const code = await run([...args, "--execution", "exact-key"], async () => ({ genevaLogs: { getExecutionLogs: async () => result } }), output);
    assert.equal(code, status === "unavailable" ? 1 : 0);
  }
});

test("invalid arguments produce an error and exit code 2 without a data result", async () => {
  let message;
  const code = await run([], async () => assert.fail("Invalid input loaded Iris"), { log: assert.fail, error: value => { message = value; } });
  assert.equal(code, 2);
  assert.equal(message, "Missing --cluster");
});


// The container exposes its Git checkout through a symlink at CLAUDE_CONFIG_DIR/skills.
test("running through a symlink executes the CLI and emits a result", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "geneva-cli-link-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "dist/index.js"), 'export const lionrock = {}; export const genevaLogs = {getExecutionLogs: async () => ({audit:{status:"ok"},tracing:{status:"ok"}})}; export const genevaMetrics = {readMonitorConfigs: async () => ({v1:{status:"ok"},v2:{status:"ok"}})};');
    symlinkSync(fileURLToPath(new URL("../", import.meta.url)), join(dir, "linked-skill"), "dir");
    const entry = join(dir, "linked-skill/bin/read.mjs");
    const commandArgs = [...args, "--execution", "exact-key"];
    const result = spawnSync(process.execPath, [entry, ...commandArgs], {env:{...process.env,IRIS_ROOT:dir},encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), "The CLI silently skipped its entrypoint");
    const output = JSON.parse(result.stdout);
    assert.equal(output.audit.status, "ok");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
