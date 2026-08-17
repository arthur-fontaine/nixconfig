# Personal preferences

These apply across all my projects.

## Comments

Default to no comment. IMPORTANT: cut before you add.

**The test.** Without this comment, would a competent reader change the code and
break something? YOU MUST be able to name that change. If you cannot, cut the comment.

Passes the test:

- A workaround for a bug outside this repo. Name the bug.
- Placement or order that looks arbitrary but is required. Say what breaks if it moves.
- A value that looks wrong or magic but is correct. Say where it comes from.
- A lint or type suppression. Say why it is safe.

Fails the test:

- Background, history, or design intent. That goes in the commit message or PR.
- A summary of the block below it.
- Anything that repeats a name, type, or signature.
- JSDoc or file headers on internal code. Public package API only.

**Form.** Two lines max. If it needs a paragraph, the commit message needs it instead.
Tests follow the same rule: the `it("...")` name is the explanation.

**TODO.** Allowed. Write `// TODO: <what to do>`, or `// TODO(KRA-1234): <what to do>`
when a ticket exists. Never leave a TODO that names a feeling ("clean this up").

## Commits

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, etc., with an optional scope (e.g. `fix(auth): …`).

## Tooling

- Use `pnpm`, never `npm` — `pnpm install`, `pnpm add`, `pnpm run …`.
