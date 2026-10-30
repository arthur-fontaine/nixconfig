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

## Disk and resources

Disk space and machine resources are limited.

- Keep the available disk, RAM, CPU and GPU in mind. Check them (`df -h`, `vm_stat`, `top -l 1`) before heavy work, and size the work to fit: limit parallel jobs, batch sizes and the number of background processes you run.
- Before downloading or generating anything over ~1 GB (dependencies, datasets, models, media, builds, renders), check `df -h`, tell me how much it will take, and reuse existing shared caches and installs instead of making a copy per project.

Clean up as you go; don't leave it for me to find later.

- Once a final result exists and is verified or published, delete what only served to produce it: intermediate files, extra copies or format variants of the same output, checkpoints or partial states of finished jobs, outputs of discarded attempts, and files downloaded for a one-off comparison or test. This covers builds, exports, renders, generated data and trained models alike.
- Delete what can be easily rebuilt or downloaded again once it's no longer in active use: dependency folders (`node_modules`, venvs), build outputs and caches, downloaded copies of public data. Keep what is small or hard to recreate: source inputs, configs, results, metrics, logs, hand-made or paid-for data.
- Remove a worktree and its local branch as soon as the branch is merged or the worktree has served its purpose, and run `git worktree prune` to clear stale records. Temporary or probe worktrees go when the task ends.
- Stop background processes you started (dev servers, renders, training jobs, watchers) once they're no longer needed.
- At the end of a task, delete what you created that isn't needed anymore (temp files, scratch outputs, test data). If you notice large things you didn't create, list them with sizes and suggest what to remove; don't delete them yourself.
- Never delete without asking: uncommitted changes, unmerged branches, or data that can't be cheaply recreated.

## Session start

- In your first reply of each session, confirm in one line that you've read these rules.
