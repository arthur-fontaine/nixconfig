# herdr-session

What Herdr's Info panel reads from Pi: the session file of each terminal (an `hc label`),
and the Claude subscription's usage in `~/.pi/agent/claude-usage.json`.

## Usage

`claude-usage.json` holds the latest utilization of the 5-hour and weekly windows (0–1,
reset in epoch seconds). Two writers:

- each response through the `claude-code` provider (its rate-limit headers), and
- `poll.ts`, which asks Anthropic's OAuth usage endpoint every 20 s, one session at a time.

## Tokens left

Each window also carries `tokensLeft` and the `estimate` behind it:

```json
"fiveHour": { "utilization": 0.43, "resetsAt": …,
  "tokensLeft": 174506624,
  "estimate": { "perPoint": 269466, "spread": 0.11, "stretches": 225, "needed": 8, "mix": 11.4, "at": … } }
```

Anthropic only gives a percentage. The estimate correlates it with the tokens the session
logs spent:

1. **History** (`history.ts`, `claude-usage.history.jsonl`): every usage write appends a
   sample when a window changed (or every 10 min), two weeks kept. The first refresh seeds
   it from the rate-limit diagnostics Pi stores on each `claude-code` response.
2. **Ledger** (`ledger.ts`, `claude-usage.ledger.json`): the subscription's token spend,
   read incrementally (an offset per file) from Pi's `sessions/*/*.jsonl` (`claude-code`
   provider only; `anthropic` may be an API key) and Claude Code's `projects/**/*.jsonl`.
   Each message counts once, by id: Claude Code repeats a message per content block, Pi
   forks copy earlier messages, and Pi's own turns sometimes also land in Claude Code's
   logs (`entrypoint: sdk-cli`). Only times, models, ids and token counts are kept.
3. **Weights**: tokens are summed in Opus input tokens: output ×5, cache writes ×2,
   cache reads ×0.05; Sonnet ×0.6, Haiku ×0.2. API prices give the shape, but a free fit
   per kind isn't identifiable (input tokens are tiny, the kinds move together). Scanning
   the cache-read and output weights against 195 stretches (Nov 3–11, 2026), cache reads
   at 0.05× (half their price ratio) made the per-stretch ratios most consistent (log
   s.d. 0.25, against 0.28 at price and 0.53 for raw tokens).
4. **Fit** (`fit.ts`): within one window (same `resetsAt`, never across a reset), runs of
   samples are cut into stretches of at least 5 points. The 1% granularity makes shorter
   ones noise. Each stretch gives weighted tokens per point. The fit is their ratio of sums,
   each weighed by its points and halved every 3 days (5 hours) or 7 days (week). Ratios
   beyond 3× of the median are dropped (points spent where no log is read). `spread` is half
   the interquartile range of the ratios, relative to the fit. Below 8 stretches (40 points
   of use) `tokensLeft` is null.
5. **Shown unit**: `tokensLeft = (1 − utilization) × 100 × perPoint × mix`, where `mix` is
   raw tokens per weighted token over the last 5 hours. So the figure is in tokens as the
   logs count them (input, output, cache reads and writes), at the recent mix. That is the
   kind of total Pi shows per turn.

`estimate.ts` refreshes the ledger and the fit at most every 5 minutes, after a poll, under
`claude-usage.estimate.lock`, so one session does the work. The first refresh reads two
weeks of logs (about 3 s); later ones read only the new lines (tens of ms). Every write of
`claude-usage.json` applies the latest fit to its utilization.

Backtest (Nov 11, 2026): 5 hours ≈ 270k weighted tokens per point (±11%); week ≈ 2.35M
(±14%). Predicting each day from the days before it, the error was 5–23% (5 hours) and
1–16% (week) since Nov 6. Nov 1–3 ran at 80–110k per point (usage outside the logs, or a
different limit); the half-life lets such a change fade within days.

## Tests

```sh
node --test 'tests/*.test.ts'
```
