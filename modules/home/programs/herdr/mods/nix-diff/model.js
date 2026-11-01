// A unified diff (`git diff`, `git show`) as files, hunks and numbered lines,
// with the changed words of each replaced line, as Zed's diff view shows them.
// No Herdr imports, so `node --test` runs it.

// Past this, a file's lines are left out and its header says so.
export const MAX_FILE_LINES = 3000;

function stripPrefix(path) {
  return path.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

export function parsePatch(text) {
  const files = [];
  let file = null, hunk = null, oldNo = 0, newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, status: "M", binary: false, hunks: [], add: 0, del: 0, lines: 0, cut: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "A";
      else if (line.startsWith("deleted file mode")) file.status = "D";
      else if (line.startsWith("rename from ")) { file.oldPath = line.slice(12); file.status = "R"; }
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (h) {
      oldNo = +h[1]; newNo = +h[2];
      hunk = { context: h[3], oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    if (kind !== " " && kind !== "+" && kind !== "-") continue; // "\ No newline at end of file"
    if (kind === "+") file.add++;
    if (kind === "-") file.del++;
    if (file.lines >= MAX_FILE_LINES) { file.cut = true; continue; }
    file.lines++;
    const text = line.slice(1).replace(/\t/g, "  ");
    if (kind === "-") hunk.lines.push({ kind, old: oldNo++, text });
    else if (kind === "+") hunk.lines.push({ kind, new: newNo++, text });
    else hunk.lines.push({ kind, old: oldNo++, new: newNo++, text });
  }
  for (const f of files) for (const h of f.hunks) markChanges(h.lines);
  return files;
}

// A new file read from disk, as a diff that adds every line.
export function addedFile(path, text) {
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, MAX_FILE_LINES);
  return {
    path, oldPath: null, status: "A", binary: false, add: lines.length, del: 0, lines: shown.length, cut: lines.length > shown.length,
    hunks: [{ context: "", oldStart: 0, newStart: 1, lines: shown.map((l, i) => ({ kind: "+", new: i + 1, text: l.replace(/\t/g, "  ") })) }],
  };
}

// Each run of removed lines followed by added ones is a change block. Its bar
// is yellow (modified) when it has both, else green or red; a removed line and
// the added line at the same place in the block get the words that differ.
export function markChanges(lines) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === " ") { i++; continue; }
    const start = i;
    while (i < lines.length && lines[i].kind === "-") i++;
    const mid = i;
    while (i < lines.length && lines[i].kind === "+") i++;
    const removed = lines.slice(start, mid), added = lines.slice(mid, i);
    const block = removed.length && added.length ? "modified" : added.length ? "added" : "removed";
    for (const l of lines.slice(start, i)) l.block = block;
    // Only a block that replaces line for line pairs its lines: otherwise the
    // k-th removed and added lines are unrelated and their "changes" are noise.
    if (removed.length === added.length) for (let k = 0; k < removed.length; k++) {
      const [a, b] = changedRanges(removed[k].text, added[k].text);
      if (a) removed[k].changed = a;
      if (b) added[k].changed = b;
    }
    if (i === start) i++;
  }
}

// The middle that differs between two lines, as [start, end) on each; none when
// the lines share too little for a highlight to help.
export function changedRanges(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Snap to word edges, so a highlight never splits a word.
  const word = /[\w$]/;
  while (p > 0 && word.test(a[p - 1] ?? "") && word.test(a[p] ?? b[p] ?? "")) p--;
  while (s > 0 && word.test(a[a.length - s] ?? "") && word.test(a[a.length - s - 1] ?? "")) s--;
  const shared = p + s, longest = Math.max(a.length, b.length);
  if (!longest || shared < longest * 0.3) return [null, null];
  const ra = a.length - s > p ? [p, a.length - s] : null;
  const rb = b.length - s > p ? [p, b.length - s] : null;
  return [ra, rb];
}

// The rows a diff view draws, in order: a header per file, then (unless the
// file is folded) a separator per hunk and its lines.
export function rowsOf(files, folded) {
  const rows = [];
  files.forEach((f, fi) => {
    rows.push({ type: "file", file: fi });
    if (folded.has(f.path)) return;
    if (f.binary) { rows.push({ type: "note", file: fi, text: "Binary file" }); return; }
    if (!f.hunks.length) { rows.push({ type: "note", file: fi, text: f.status === "R" ? `Renamed from ${f.oldPath}` : "No text changes" }); return; }
    f.hunks.forEach((h, hi) => {
      // A fold mark where lines are skipped: between hunks, and before the first one unless it starts the file.
      if (hi > 0 || h.oldStart > 1 || h.newStart > 1) rows.push({ type: "hunk", file: fi, hunk: hi });
      else rows.push({ type: "gap", file: fi });
      for (const line of h.lines) rows.push({ type: "line", file: fi, line });
    });
    if (f.cut) rows.push({ type: "note", file: fi, text: `Showing the first ${MAX_FILE_LINES} lines` });
    rows.push({ type: "end", file: fi });
  });
  return rows;
}
