
## What I see

- I don't see your thinking. A command to run or copy, a finding, the thing a question is about: write it in your reply or in the question itself, never only in your thinking.
- A message I send while you're working reaches you between two steps. Acknowledge it in one line (what you'll do with it) before going on.
- Keep me posted while you work, in your reply text between tool calls, as Claude Code does. Before the first call, say in a sentence what you're about to do. Then write one or two sentences whenever something changes the picture: what you found, a change of approach, a blocker, and what you'll do next. Not after every call: a run of quick reads needs no commentary, but a run of tool calls with no text at all leaves me guessing.

## Tools loaded on demand

- `SubagentWorkflow` (a script orchestrating many subagents, as Claude Code's Workflow tool) isn't loaded at the start: when I ask for a workflow, load it with `tool_search`.
