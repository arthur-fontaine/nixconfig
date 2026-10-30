import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightShell } from "../highlight.ts";
import { lexShell } from "../shell.ts";
import { fakePaint, markup, stripAnsi } from "./paint.ts";

const show = (command: string, paint = fakePaint()) => highlightShell(paint, command).map(markup);

test("command names, options, strings, operators and comments take syntax colors", () => {
	assert.deepEqual(show("git status --short | grep -v '^??' > out.txt # note"), [
		"[function:git][title: status ][type:--short][title: ][operator:|][title: ][function:grep][title: ][type:-v][title: ][string:'^??'][title: ][operator:>][title: out.txt ][comment:# note]",
	]);
});

test("keywords, loop variables and expansions", () => {
	assert.deepEqual(show('for f in *.ts; do echo "$f ${f%.ts}"; done'), [
		'[keyword:for][title: ][variable:f][title: ][keyword:in][title: *.ts][operator:;][title: ][keyword:do][title: ][function:echo][title: ][string:"][variable:$f][string: ][variable:${f%.ts}][string:"][operator:;][title: ][keyword:done]',
	]);
	assert.deepEqual(show("[[ -f x ]] && exit 1"), ["[keyword:[[][title: ][type:-f][title: x ][keyword:]]][title: ][operator:&&][title: ][function:exit][title: ][number:1]"]);
	assert.deepEqual(show("X=1 make"), ["[variable:X][operator:=][title:1 ][function:make]"]);
});

test("a program passed to an interpreter is highlighted in its language", () => {
	const paint = fakePaint();
	assert.deepEqual(show("FOO=1 uv run python3 -c 'print(42)' | tee log", paint), [
		"[variable:FOO][operator:=][title:1 ][function:uv][title: run python3 ][type:-c][title: ][string:'][keyword:print(42)][string:'][title: ][operator:|][title: ][function:tee][title: log]",
	]);
	assert.deepEqual(paint.calls, ["python:print(42)"]);
});

test("each interpreter's program is found where it takes it", () => {
	const languages = (command: string) =>
		lexShell(command)
			.filter((span) => span.language)
			.map((span) => `${span.language}:${command.slice(span.start, span.end)}`);
	assert.deepEqual(languages(`node -e "console.log(1)"`), ["javascript:console.log(1)"]);
	assert.deepEqual(languages(`sudo psql -U me -c 'select 1'`), ["sql:select 1"]);
	assert.deepEqual(languages(`awk -F: '{print $1}' /etc/passwd`), ["awk:{print $1}"]);
	assert.deepEqual(languages(`sqlite3 db 'pragma x' 'select 2'`), ["sql:select 2"]);
	assert.deepEqual(languages(`/usr/bin/python3.12 -c "x"`), ["python:x"]);
	assert.deepEqual(languages(`timeout 5 ruby -e 'p 1'`), ["ruby:p 1"]);
	// Not a whole quoted word, so not a program.
	assert.deepEqual(languages(`python -c 'a'b`), []);
	assert.deepEqual(languages(`echo -c 'print(1)'`), []);
});

test("heredocs take the language of the command reading them, or of the file written", () => {
	const languages = (command: string) =>
		lexShell(command, (path) => (path.endsWith(".py") ? "python" : undefined))
			.filter((span) => span.language)
			.map((span) => `${span.language}:${command.slice(span.start, span.end)}`);
	assert.deepEqual(languages("python3 - <<'EOF'\nimport os\nprint(os)\nEOF\necho done"), ["python:import os\nprint(os)"]);
	assert.deepEqual(languages("cat > a.py <<EOF\nx = 1\nEOF"), ["python:x = 1"]);
	assert.deepEqual(languages("cat <<EOF > a.py\nx = 1\nEOF"), ["python:x = 1"]);
	assert.deepEqual(languages("tee -a a.py <<-EOF\n\tx = 1\n\tEOF"), ["python:\tx = 1"]);
	assert.deepEqual(languages("psql <<SQL\nselect 1;\nSQL"), ["sql:select 1;"]);
	// Still streaming: the body runs to the end.
	assert.deepEqual(languages("node <<'JS'\nconst a = 1;\nconsole.lo"), ["javascript:const a = 1;\nconsole.lo"]);
});

test("a heredoc for no known language is a string, its delimiters keywords", () => {
	assert.deepEqual(show("cat <<EOF\nhello\nEOF\nls"), ["[function:cat][title: ][operator:<<][keyword:EOF]", "[string:hello]", "[keyword:EOF]", "[function:ls]"]);
});

test("bash -c programs are highlighted as shell, nested ones in their language", () => {
	const paint = fakePaint();
	assert.deepEqual(show(`bash -c 'python -c "x=1"'`, paint), [
		`[function:bash][title: ][type:-c][title: ][string:'][function:python][title: ][type:-c][title: ][string:"][keyword:x=1][string:"][string:']`,
	]);
	assert.deepEqual(paint.calls, ["python:x=1"]);
});

test("a language the highlighter doesn't know stays a string", () => {
	assert.deepEqual(show(`node -e 'x'`, fakePaint({ javascript: false })), ["[function:node][title: ][type:-e][title: ][string:'][string:x][string:']"]);
});

test("command substitutions are lexed as commands", () => {
	assert.deepEqual(show("x=$(date +%s); echo $((x+1)) `whoami`"), [
		"[variable:x][operator:=][operator:$(][function:date][title: +%s][operator:)][operator:;][title: ][function:echo][title: ][variable:$((x+1))][title: ][operator:`][function:whoami][operator:`]",
	]);
});

test("the text is never changed, whatever the input", () => {
	const commands = [
		"echo 'unterminated",
		'echo "a $(ls',
		"cat <<EOF\nno end",
		") stray ( and `",
		"a\\\nb \\",
		"case $x in a) echo 1;; *) echo 2;; esac",
		"f() { local a=1; echo ${a:-x}; }",
		"echo $'a\\'b' $\"x\"",
		"ls 2>&1 >/dev/null &>> log <<< 'w' <(cat) | cat",
		"",
	];
	for (const command of commands) {
		assert.equal(highlightShell(fakePaint(), command).map(stripAnsi).join("\n"), command, command);
	}
});
