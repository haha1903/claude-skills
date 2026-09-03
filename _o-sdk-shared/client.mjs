/**
 * Shared bootstrap for o-* skills. Loads the iris SDK and returns an
 * Agent365Client.
 *
 * Uses the self-contained bundle vendored under _iris-shared by default (no
 * ~/Projects/iris checkout or node_modules needed); set IRIS_ROOT to load a
 * source `dist/` build instead. Regenerate the bundle after changing iris:
 * run `npm run bundle:skills` in ~/Projects/iris.
 *
 *   import { openClient } from "../../_o-sdk-shared/client.mjs";
 *   const c = await openClient();
 *   const mail = await c.mail();
 *   ...
 *   await c.close();
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Sends that would reach someone else, and where they land instead.
 *
 * This bridge is in loop so the on-call items can READ channels and mail. Vendoring it
 * brought `sendToChannel` / `sendToChat` / `sendToUser` along too, and those are a
 * different matter: a post to the Support channel goes out under Hai's name, carries a
 * request id and a root cause, and tells a colleague what to do. It cannot be recalled,
 * and whether the answer is right is a judgement belonging to someone who has the context.
 *
 * They are not blocked. Blocking yields "I could not send it" and loses the text, which is
 * the expensive part. They are REDIRECTED to Hai's own chat with a banner naming the
 * destination, so he can read it and paste it there himself. Drafting stays automatic;
 * publishing stays human.
 *
 * `sendToSelf` is untouched, and so is every read.
 */
const REDIRECTED = {
  sendToChannel: (a) => `channel ${a?.channelId ?? "?"} (team ${a?.teamId ?? "?"})`,
  sendToChat: (a) => `chat ${a?.chatId ?? "?"}`,
  sendToUser: (a) => `user ${a?.userIdOrUpn ?? "?"}`,
  replyToPost: (a) => `a reply under post ${a?.messageId ?? "?"}`,
  replyToPostByUrl: (a) => `a reply under ${a?.url ?? "?"}`,
};

/**
 * Wrap a TeamsClient so its outbound methods deliver to Hai.
 *
 * The banner earns its place: a draft arriving with no idea what it was for cannot be
 * pasted anywhere, and pasting it at the right destination is the entire point.
 */
function guardTeams(teams) {
  for (const [name, describe] of Object.entries(REDIRECTED)) {
    if (typeof teams[name] !== "function") continue;
    teams[name] = async (args = {}, ...rest) => {
      const where = describe(args);
      // iris's send methods take `content`, not `text`. Writing the wrong key left
      // content undefined and blew up inside escapeTeamsContent -- a guard that throws is
      // worse than no guard, since the caller cannot tell refusal from a broken tool.
      const body = args.content ?? args.text ?? args.message ?? "";
      const banner =
        `**Draft for ${where} — NOT sent.** Review it, then paste it there yourself.\n\n---\n\n`;
      const r = await teams.sendToSelf({ ...args, content: banner + body }, ...rest);
      return { ...r, redirected: true, intendedFor: where };
    };
  }
  return teams;
}

export async function openClient() {
  const entry = process.env.IRIS_ROOT
    ? pathToFileURL(path.join(process.env.IRIS_ROOT, "dist/index.js")).href
    : new URL("../_iris-shared/iris.bundle.mjs", import.meta.url).href;
  const mod = await import(entry);
  const client = new mod.Agent365Client();

  // Wrapped at the accessor rather than afterwards: callers do `await c.teams()`, so every
  // handle they can obtain is already guarded and there is nothing to reach around.
  const realTeams = client.teams.bind(client);
  client.teams = async (...a) => guardTeams(await realTeams(...a));

  return client;
}

export function todayBounds() {
  const now = new Date();
  const s = new Date(now); s.setHours(0, 0, 0, 0);
  const e = new Date(now); e.setHours(23, 59, 59, 999);
  return { startISO: s.toISOString(), endISO: e.toISOString() };
}
export function isoDaysAgo(days) {
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString();
}
export function fmtTime(iso) {
  return (iso ?? "").slice(0, 16).replace("T", " ");
}
