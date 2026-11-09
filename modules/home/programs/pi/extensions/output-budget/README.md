# Output budget

A `bash` result over 16,000 characters reaches the model as its first 4,000
and last 10,000 characters, cut at line breaks, around a line saying how much
was left out and where the whole output is: Pi's own full-output file when
Pi truncated it, otherwise `~/.pi/agent/tmp/output-budget/<call id>.txt`.

Pi's limit (50KB or 2,000 lines) lets one `cat` of a big file or one long log
put ~12k tokens in the context, where they stay for every later request.

Only single-text `bash` results are touched; images, `read` and other tools
are left as they are.

## Tests

```sh
node --test 'modules/home/programs/pi/extensions/output-budget/tests/*.test.ts'
```

Checked in Pi 1.5.0 with `pi -e`: `cat` of a 5,000-line file came back at
14k characters instead of ~28k, with Pi's full-output path in the marker.
