# Personal preferences

These apply across all my projects.

## Comments

- Add comments only when they earn their place — don't over-comment.
- Don't restate what the code already makes clear.
- Do comment to justify a non-obvious decision (the "why") or to clarify a complex algorithm.

## Commits

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, etc., with an optional scope (e.g. `fix(auth): …`).
- Commit each logical change as soon as it's done, before starting the next one — scaffolding included. Never batch commits at the end.
- If commit signing fails, commit with `--no-gpg-sign` and remind me to sign them later.

## Tooling

- Use `pnpm`, never `npm` — `pnpm install`, `pnpm add`, `pnpm run …`.

## My Mac

- Never change my Mac's settings or apps directly (`defaults write`/`import`, editing app prefs or dotfiles, `brew install`, removing apps, `killall` to apply a change). Make the change in my nixconfig repo and ask me to run `! rebuild`.
- If something can't be managed there, tell me and let me do it.

## Session start

- In your first reply of each session, confirm in one line that you've read these rules.
