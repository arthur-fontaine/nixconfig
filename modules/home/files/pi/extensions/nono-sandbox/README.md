# pi nono sandbox

Local Pi extension using **actual `nono-ts` OS sandboxing**.

## Design

This extension applies a **strict process-wide sandbox** to the running Pi process on session start.
That means:

- built-in tools run under real OS-enforced restrictions
- `bash` / `!` child processes inherit the sandbox
- file access outside granted paths is blocked by the kernel/backend

## Important consequence

`nono-ts apply()` is **irreversible** for the lifetime of the process.
So:

- grants are **not hot-refreshable**
- when you save a new permission, you must **restart Pi** for it to apply

## Config layering

Defaults are shipped in:
- `~/.pi/agent/extensions/nono-sandbox/defaults.json`

User overrides:
- global: `~/.pi/agent/nono-sandbox.json`
- project: `<cwd>/.pi/nono-sandbox.json`

Only put overrides in the user config files.

## Commands

- `/sandbox` — show the active strict policy
- `/sandbox-allow` — persist a path grant for the next Pi launch

## Input box integration

The sandbox state is exposed through `ctx.ui.setStatus()` keys that the local `input-box.ts` extension renders inside the docked editor chrome.

## Approval behavior

- dangerous commands still ask for confirmation
- blocked file accesses can offer to save a future grant
- future grants require a full Pi restart because the active sandbox cannot be expanded in place
