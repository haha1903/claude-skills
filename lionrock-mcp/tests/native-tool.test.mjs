import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const nativeTool = {
  name: "get_request_approvers",
  description: "Native Lionrock approver lookup",
  inputSchema: { type: "object", required: ["id", "subRequestId"] },
};
const nativeResult = {
  found: true, requestId: "11282636", subRequestId: 1,
  region: "Delos Cloud Germany North", status: "Created",
  approvals: [
    { type: "AG", pending: false, by: "System", at: null, comments: null, approvers: ["ag-candidate"] },
    { type: "GCT", pending: true, by: null, at: null, comments: null, approvers: ["gct-candidate"] },
  ],
};

async function run(t, args, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lionrock-native-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "lionrock-mcp/bin"), { recursive: true });
  await mkdir(path.join(root, "_iris-shared"));
  const cli = path.join(root, "lionrock-mcp/bin/lionrock-mcp");
  await copyFile(new URL("../bin/lionrock-mcp", import.meta.url), cli);
  const callsFile = path.join(root, "calls.jsonl");
  await writeFile(path.join(root, "_iris-shared/index.mjs"), `
    import { appendFileSync } from 'node:fs';
    const log = (value) => appendFileSync(process.env.CLI_TEST_CALLS, JSON.stringify(value) + '\\n');
    export const mcpHttp = {
      LIONROCK_PROD: { url: 'https://example.invalid/mcp' },
      McpHttpClient: class {
        cachePath = '/test/msal-cache';
        async listTools() { return [${JSON.stringify(nativeTool)}]; }
        async callTool(name, args) {
          log({name, args});
          if (process.env.CLI_TEST_ERROR) throw new Error(process.env.CLI_TEST_ERROR);
          return [{type: 'text', text: process.env.CLI_TEST_RESULT}];
        }
      },
    };
    export const auth = { McpAuthProvider: class {} };
    export const lionrock = {
      REQUEST_APPROVERS_TOOL: { name: 'get_request_approvers', description: 'Legacy portal helper' },
      LionrockApproversClient: class {
        constructor() { throw new Error('The portal helper must not shadow the deployed MCP tool'); }
      },
    };
  `);
  const child = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLI_TEST_CALLS: callsFile,
      CLI_TEST_RESULT: JSON.stringify(options.result ?? nativeResult),
      CLI_TEST_ERROR: options.error ?? "",
    },
  });
  assert.ifError(child.error);
  const calls = await readFile(callsFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { ...child, payload: child.stdout.trim() ? JSON.parse(child.stdout) : null, calls: calls.trim() ? calls.trim().split("\n").map(JSON.parse) : [] };
}

test("tools exposes the deployed approver schema without replacing it with the portal helper", async t => {
  const result = await run(t, ["tools"]);
  assert.equal(result.status, 0);
  assert.equal(result.payload.count, 1);
  assert.deepEqual(result.payload.tools, [nativeTool]);
});

test("approver calls use native MCP and retain approved and pending rows verbatim", async t => {
  const args = { id: "11282636-1", subRequestId: 1 };
  const result = await run(t, ["call", nativeTool.name, JSON.stringify(args)]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [{ name: nativeTool.name, args }]);
  assert.deepEqual(result.payload, { ok: true, tool: nativeTool.name, result: nativeResult });
});

test("a native parameter error is preserved without falling back to a different sub-request", async t => {
  const args = { id: "11282636-2", subRequestId: 1 };
  const response = { found: false, message: "Invalid parameters: combined id does not match subRequestId." };
  const result = await run(t, ["call", nativeTool.name, JSON.stringify(args)], { result: response });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [{ name: nativeTool.name, args }]);
  assert.deepEqual(result.payload.result, response);
});

test("native MCP permission denial is an authorization failure", async t => {
  const result = await run(t, ["call", "get_request_status", '{"id":"11282636"}'], { error: "MCP 403 on tools/call" });
  assert.equal(result.status, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.kind, "not-authorised");
});

test("native MCP authentication failure retains the token-reimport guidance", async t => {
  const result = await run(t, ["call", "get_request_status", '{"id":"11282636"}'], { error: "MCP 401 on tools/call" });
  assert.equal(result.status, 1);
  assert.equal(result.payload.kind, "not-authorised");
  assert.equal(result.payload.cachePath, "/test/msal-cache");
  assert.match(result.payload.fix, /re-import/);
});
