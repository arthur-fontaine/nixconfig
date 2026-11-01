// Line-at-a-time syntax colors for diff lines. Herdr's mods can only color
// text they split themselves, so this is a small lexer, not tree-sitter: it
// knows comments, strings, numbers, keywords, types and calls, which is most
// of what Zed's theme colors in a diff. Multi-line strings and comments are
// colored from the line they start on.

const KEYWORDS = {
  js: "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return set static super switch this throw try type typeof var void while with yield",
  nix: "assert else if in inherit let or rec then with import",
  lua: "and break do else elseif end for function goto if in local not or repeat return then until while",
  rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  sh: "case do done elif else esac fi for function if in local return select then until while export",
  swift: "as associatedtype break case catch class continue default defer do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var where while",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while",
};
const CONSTANTS = new Set("true false null undefined nil None True False NaN Infinity".split(" "));

const LANG = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", json: "json", jsonc: "json",
  nix: "nix", lua: "lua", rs: "rust", py: "py", go: "go", sh: "sh", bash: "sh", zsh: "sh", swift: "swift",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", m: "c", css: "css", scss: "css", md: "md", toml: "toml", yaml: "toml", yml: "toml",
};

export function languageOf(path) {
  const name = path.split("/").pop();
  if (/^\.?(zshrc|bashrc|profile)$/.test(name)) return "sh";
  return LANG[name.includes(".") ? name.split(".").pop().toLowerCase() : ""] ?? null;
}

const LINE_COMMENT = { js: "//", json: "//", rust: "//", go: "//", swift: "//", c: "//", css: null, nix: "#", py: "#", sh: "#", toml: "#", lua: "--" };
const BLOCK_COMMENT = { js: ["/*", "*/"], rust: ["/*", "*/"], go: ["/*", "*/"], swift: ["/*", "*/"], c: ["/*", "*/"], css: ["/*", "*/"], nix: ["/*", "*/"], json: ["/*", "*/"] };
const words = {};
const keywordsOf = (lang) => (words[lang] ??= new Set((KEYWORDS[lang] ?? "").split(" ")));

// [{text, kind}] covering the line; kind is null for plain text.
export function tokenize(text, lang) {
  if (!lang || lang === "md") return [{ text, kind: null }];
  const out = [];
  const push = (t, kind) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += t;
    else out.push({ text: t, kind });
  };
  const lc = LINE_COMMENT[lang], bc = BLOCK_COMMENT[lang], kw = keywordsOf(lang);
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (lc && rest.startsWith(lc)) { push(rest, "comment"); break; }
    if (bc && rest.startsWith(bc[0])) {
      const end = rest.indexOf(bc[1], bc[0].length);
      const n = end < 0 ? rest.length : end + bc[1].length;
      push(rest.slice(0, n), "comment"); i += n; continue;
    }
    const c = text[i];
    if (lang === "nix" && rest.startsWith("''")) {
      const end = rest.indexOf("''", 2);
      const n = end < 0 ? rest.length : end + 2;
      push(rest.slice(0, n), "string"); i += n; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      push(text.slice(i, j + 1), "string"); i = j + 1; continue;
    }
    const num = /^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(rest);
    if (num && !/[\w$]/.test(text[i - 1] ?? "")) { push(num[0], "number"); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const w = id[0], after = text.slice(i + w.length);
      const kind = kw.has(w) ? "keyword"
        : CONSTANTS.has(w) ? "constant"
        : lang === "json" ? null
        : /^\s*\(/.test(after) ? "function"
        : /^[A-Z]/.test(w) ? "type"
        : (lang === "nix" || lang === "toml" || lang === "css") && /^\s*[=:]/.test(after) ? "property"
        : /^\s*:/.test(after) && lang === "js" ? "property"
        : null;
      push(w, kind); i += w.length; continue;
    }
    if (/[{}()[\];,.]/.test(c)) { push(c, "punctuation"); i++; continue; }
    if (/[=+\-*/<>!&|?:%^~]/.test(c)) { push(c, "operator"); i++; continue; }
    push(c, null); i++;
  }
  return out;
}

// Tokens cut at [start, end), the changed words, so they can be drawn on their own background.
export function splitAt(tokens, range) {
  if (!range) return tokens.map((t) => ({ ...t, changed: false }));
  const out = [];
  let at = 0;
  for (const t of tokens) {
    const from = at, to = at + t.text.length;
    const cuts = [from, Math.max(from, Math.min(to, range[0])), Math.max(from, Math.min(to, range[1])), to];
    for (let k = 0; k < 3; k++) {
      const piece = t.text.slice(cuts[k] - from, cuts[k + 1] - from);
      if (piece) out.push({ text: piece, kind: t.kind, changed: k === 1 });
    }
    at = to;
  }
  return out;
}
