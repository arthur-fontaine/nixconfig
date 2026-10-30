import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
	buildSystemPrompt,
	fillSlots,
	identityContext,
	loadTemplates,
	ruleName,
	SEVERITY_OUTPUT,
	slotText,
	stripArtifactRule,
	thresholdsFor,
	userIdentity,
} from "../prompt.ts";

// node --test runs each file in its own process, with the file as argv[1].
const templates = loadTemplates(path.join(path.dirname(process.argv[1]!), ".."));

test("a user list replaces a slot's defaults, and $defaults splices them back in", () => {
	assert.equal(slotText(undefined, "- A\n- B"), "- A\n- B");
	assert.equal(slotText([], "- A"), "- A");
	assert.equal(slotText(["mine"], "- A"), "- mine");
	assert.equal(slotText(["first", "$defaults", "last", "$defaults"], "- A"), "- first\n- A\n- last");
});

test("slots and the deny-rules marker are filled in place", () => {
	const template = "x\n<user_allow_rules_to_replace>- D</user_allow_rules_to_replace>\n<settings_deny_rules>\ny";
	assert.equal(fillSlots(template, {}, ""), "x\n- D\n\ny");
	assert.equal(fillSlots(template, { allow: ["ok"] }, "- deny"), "x\n- ok\n- deny\ny");
});

test("the system prompt has every placeholder resolved and the severity output format", () => {
	const prompt = buildSystemPrompt({ rules: {}, identity: "arthur", severity: true });
	for (const leftover of ["<permissions_template>", "<cross_session_messages_rule>", "_to_replace>", "<settings_deny_rules>"])
		assert.ok(!prompt.includes(leftover), leftover);
	assert.ok(prompt.startsWith("You are a security monitor for autonomous AI coding agents."));
	assert.ok(prompt.includes("<cc_automode_permissions>\n## Environment"));
	assert.ok(prompt.includes(`## Output Format\n\n${SEVERITY_OUTPUT}`));
	assert.ok(!prompt.includes("<block>yes</block>"));
	assert.ok(prompt.endsWith(identityContext("arthur")));
	assert.ok(!prompt.includes("- Unrequested Artifact Publish "));
});

test("the block-format prompt keeps Claude Code's own output section", () => {
	const prompt = buildSystemPrompt({ rules: {}, identity: null, severity: false });
	assert.ok(prompt.includes("<block>yes</block><category>Exact BLOCK Rule Name</category>"));
	assert.ok(prompt.endsWith("Do NOT include a <category> or <reason> tag when the action is allowed."));
});

test("user rules reach their slots", () => {
	const prompt = buildSystemPrompt({ rules: { environment: ["$defaults", "Trusted repo: github.com/me"], hard_deny: ["Never touch prod"] }, identity: null, severity: true });
	assert.ok(prompt.includes("- **Organization**: None configured"));
	assert.ok(prompt.includes("- Trusted repo: github.com/me"));
	assert.ok(prompt.includes("- Never touch prod"));
	assert.ok(!prompt.includes("- Data Exfiltration: Sensitive data crossing"), "hard_deny defaults replaced");
});

test("the artifact rule strip keeps the template whole when it would be partial", () => {
	assert.ok(templates.permissions.includes("- Unrequested Artifact Publish "));
	assert.ok(!stripArtifactRule(templates.permissions).includes("- Unrequested Artifact Publish "));
	const short = "- Unrequested Artifact Publish [x]: short\n";
	assert.equal(stripArtifactRule(short), short);
});

test("rule names come from the template; models map to their severity thresholds", () => {
	assert.equal(ruleName("data_exfiltration"), "Data Exfiltration");
	assert.equal(ruleName("irreversible_local_destruction"), "Irreversible Local Destruction");
	assert.deepEqual(thresholdsFor("claude-sonnet-5"), { t1: 25, t2: 35 });
	assert.deepEqual(thresholdsFor("claude-sonnet-5[1m]"), { t1: 25, t2: 35 });
	assert.equal(thresholdsFor("claude-opus-5-5"), null);
});

test("the user identity is the account name, cleaned", () => {
	assert.equal(userIdentity({ USER: "arthur-fontaine" }), "arthur-fontaine");
	assert.equal(userIdentity({ GITHUB_ACTOR: "gh user!", USER: "x" }), "ghuser");
	assert.equal(userIdentity({}), null);
});
