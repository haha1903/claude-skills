---
name: wf-notify
description: Use inside a tasks-gateway workflow task to (1) raise an actionable Notification the user must close in the gateway UI, and (2) send a Teams progress/alert message to the user. Triggers when a workflow step needs the user's attention (e.g. "check PoP", "find an approver") or when reporting progress / problems ("PR merged", "rollout failed"). Always use bin/notify.mjs — never hand-roll the curl.
---

# wf-notify

Two things a workflow task needs to tell the user about:

- **Notification** — an actionable TODO the user closes in the gateway UI
  (Notifications tab). Use for things only the user can do: "check PoP",
  "find an approver". Stays open until the user clicks Done, OR until you
  detect the condition is met and close it via the gateway API.
- **Teams message** — a fire-and-forget progress/alert ping. Use for "PR
  created", "PR merged", "build started", "rollout complete", "something
  failed — needs your attention".

## Commands

Send a Teams message:
```
bin/notify.mjs teams "PR #12345 merged; buddy build started"
```

Raise a notification (optionally also ping Teams):
```
bin/notify.mjs add --title "Check PoP for PR #12345" \
  --task "<task-name>" \
  --body "Proof-of-presence policy is pending; confirm it passed." \
  --link "https://dev.azure.com/.../pullrequest/12345" \
  --kind "pop-check" \
  --teams
```

Prints `notification created: <id>` — keep the id if you'll close it later.

## Listing and closing notifications

List this task's open notifications (id, status, kind, title — tab-separated):
```
bin/notify.mjs list --task "<task-name>"
```
Add `--all` to include already-closed ones. Omit `--task` to list everything.

When you detect a notification's condition is satisfied (e.g. you ran
`wf-release status` and the PR is merged / the approval gate passed), close it
so the user doesn't have to:
```
bin/notify.mjs done <id>
```

This is the backbone of a `notification-hygiene` heartbeat check: `list --task`
to see what's still open, verify each against the real world, `done <id>` the
ones whose reason is moot.

## Rules

- Raise a notification for things **the user must do** (approve, check PoP).
- Send a Teams message for **every meaningful progress step** and for any
  failure (the user wants to be kept in the loop).
- Don't spam: one Teams message per real state change, not per poll.
