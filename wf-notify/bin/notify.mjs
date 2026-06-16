#!/usr/bin/env node
// wf-notify — raise/list/close gateway Notifications and/or send Teams messages.
//
//   notify.mjs teams "<message>"
//   notify.mjs add  --title "..." [--task X] [--body "..."] [--link URL] [--kind K] [--teams]
//   notify.mjs list [--task X] [--all]      # open only by default; --all includes done
//   notify.mjs done <id>                    # close a notification you raised
//
// gateway notification endpoint needs no auth (localhost only); Teams goes via
// the BET bot. Both URLs/keys are fixed for this deployment.

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:4567";
const BET_BOT = process.env.BET_BOT_URL;
const BET_KEY = process.env.BET_BOT_API_KEY;
const BET_USER = process.env.BET_NOTIFY_USER;

// Only the Teams path needs BET bot creds; list/done/add-without-teams talk
// only to the local gateway. Check lazily so those still work without them.
function requireTeamsEnv() {
  if (!BET_BOT || !BET_KEY || !BET_USER) {
    console.error("Missing env: BET_BOT_URL, BET_BOT_API_KEY, BET_NOTIFY_USER");
    process.exit(1);
  }
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
  requireTeamsEnv();
  const r = await fetch(BET_BOT, {
    method: "POST",
    headers: { "api-key": BET_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ userName: BET_USER, message: { type: "text", text } }),
  });
  if (!r.ok) throw new Error(`Teams send failed ${r.status}: ${await r.text()}`);
  return r.text();
}

async function listNotifications(f) {
  const r = await fetch(`${GATEWAY}/api/notifications`);
  if (!r.ok) throw new Error(`notification list failed ${r.status}: ${await r.text()}`);
  const { notifications = [] } = await r.json();
  return notifications.filter((n) => {
    if (f.task && n.task !== f.task) return false;
    if (!f.all && n.status !== "open") return false;
    return true;
  });
}

async function closeNotification(id) {
  const r = await fetch(`${GATEWAY}/api/notifications/${encodeURIComponent(id)}/done`, { method: "POST" });
  if (!r.ok) throw new Error(`notification done failed ${r.status}: ${await r.text()}`);
  return r.json();
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
} else if (cmd === "list") {
  const f = parseFlags(argv.slice(1));
  const ns = await listNotifications(f);
  if (ns.length === 0) { console.log("(no notifications)"); }
  else for (const n of ns) console.log(`${n.id}\t[${n.status}]\t${n.kind || "-"}\t${n.title}`);
} else if (cmd === "done") {
  const id = argv[1];
  if (!id) { console.error("usage: notify.mjs done <id>"); process.exit(1); }
  await closeNotification(id);
  console.log(`closed: ${id}`);
} else {
  console.error("usage: notify.mjs teams \"<msg>\" | add --title \"...\" [flags] | list [--task X] [--all] | done <id>");
  process.exit(1);
}
