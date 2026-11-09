# Verify gate

A run that changed code and ran nothing afterwards that could show it working
is sent back once before it settles (`agent_before_settle` with
`continue: true`). The hidden reminder asks the agent to run the check where
the code really runs (the `run-and-verify` skill), or to say plainly in its
reply what isn't verified and why.

- **A change**: after each `edit`, `write` or `bash` call, the working tree is
  compared with the commit the run started on (`git diff` plus untracked
  files), Markdown aside. A commit is not a change; a further edit to a file
  already changed is.
- **A check**: any `bash` call that does more than look. Reading, searching,
  moving files and git bookkeeping (`status`, `diff`, `add`, `commit`…) only
  look; a build, a test, the program itself, `curl`, `ssh`, `git push` count.
  This errs toward not nagging: the point is to catch "edited, said done".
- Once per run at most, only in a git repository, and not for calls made by
  another tool.

## Tests

```sh
node --test 'modules/home/programs/pi/extensions/verify-gate/tests/*.test.ts'
```

Checked in Pi 1.5.0 with `pi -e`: an edit followed by "done" got the reminder
and the agent then said what wasn't verified; an edit followed by
`node a.js` got none.
