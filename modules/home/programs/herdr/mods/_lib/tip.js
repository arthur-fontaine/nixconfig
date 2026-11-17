// A tooltip's text: Herdr draws a tooltip as one plain string as wide as its longest line, so long
// text is wrapped here (at spaces, a token with none cut hard) and capped.
export function tipText(text, width = 72, max = 24) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const indent = raw.match(/^\s*/)[0].slice(0, Math.floor(width / 2));
    const room = width - indent.length;
    let line = "";
    for (let word of raw.trim().split(/ +/)) {
      while (word.length > room) {
        if (line) { out.push(indent + line); line = ""; }
        out.push(indent + word.slice(0, room));
        word = word.slice(room);
      }
      if (line && line.length + 1 + word.length > room) { out.push(indent + line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line ? indent + line : "");
  }
  return out.length > max ? [...out.slice(0, max), `… +${out.length - max} lines`].join("\n") : out.join("\n");
}
