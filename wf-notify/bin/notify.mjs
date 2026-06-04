#!/usr/bin/env node
// wf-notify — raise a gateway Notification and/or send a Teams message.
//
//   notify.mjs teams "<message>"
//   notify.mjs add --title "..." [--task X] [--body "..."] [--link URL] [--kind K] [--teams]
//
// gateway notification endpoint needs no auth (localhost only); Teams goes via
// the BET bot. Both URLs/keys are fixed for this deployment.

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:4567";
const BET_BOT = process.env.BET_BOT_URL;
const BET_KEY = process.env.BET_BOT_API_KEY;
const BET_USER = process.env.BET_NOTIFY_USER;
if (!BET_BOT || !BET_KEY || !BET_USER) {
  console.error("Missing env: BET_BOT_URL, BET_BOT_API_KEY, BET_NOTIFY_USER");
  process.exit(1);
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function sendTeams(text) {
  const r = await fetch(BET_BOT, {
    method: "POST",
    headers: { "api-key": BET_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ userName: BET_USER, message: { type: "text", text } }),
  });
  if (!r.ok) throw new Error(`Teams send failed ${r.status}: ${await r.text()}`);
  return r.text();
}

async function addNotification(f) {
  const body = { title: f.title, task: f.task, body: f.body, link: f.link, kind: f.kind };
  if (f["auto-check"]) {
    try { body.autoCheck = JSON.parse(f["auto-check"]); }
    catch { console.error("--auto-check must be valid JSON"); process.exit(1); }
  }
  if (f["check-params"]) {
    try { body.checkParams = JSON.parse(f["check-params"]); }
    catch { console.error("--check-params must be valid JSON"); process.exit(1); }
  }
  const r = await fetch(`${GATEWAY}/api/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`notification create failed ${r.status}: ${await r.text()}`);
  return r.json();
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "teams") {
  const msg = argv.slice(1).join(" ");
  if (!msg) { console.error("usage: notify.mjs teams \"<message>\""); process.exit(1); }
  await sendTeams(msg);
  console.log("teams sent");
} else if (cmd === "add") {
  const f = parseFlags(argv.slice(1));
  if (!f.title) { console.error("usage: notify.mjs add --title \"...\" [--task X] [--body ...] [--link URL] [--kind K] [--teams]"); process.exit(1); }
  const n = await addNotification(f);
  console.log(`notification created: ${n.id}`);
  if (f.teams) { await sendTeams(`[${f.task || "gateway"}] ${f.title}${f.link ? `\n${f.link}` : ""}`); console.log("teams sent"); }
} else {
  console.error("usage: notify.mjs teams \"<msg>\" | notify.mjs add --title \"...\" [flags]");
  process.exit(1);
}
