import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import rulesExtension, { collectRules, stripFrontmatter } from "./index.js";

let home;
let project;
let outside;
let originalHome;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rules-home-"));
  project = mkdtempSync(join(tmpdir(), "rules-proj-"));
  outside = mkdtempSync(join(tmpdir(), "rules-outside-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of [home, project, outside]) rmSync(dir, { recursive: true, force: true });
});

function writeRule(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Register the extension against a fake `pi` and expose its handlers. */
function loadExtension() {
  const handlers = {};
  rulesExtension({ on: (name, handler) => (handlers[name] = handler) });
  return {
    sessionStart: (reason) => handlers.session_start({ type: "session_start", reason }, { cwd: project }),
    beforeAgentStart: async (contextFiles, forceSystemPrompt) => {
      const event = {
        type: "before_agent_start",
        prompt: "hi",
        systemPromptOptions: { contextFiles, forceSystemPrompt },
      };
      const result = await handlers.before_agent_start(event, { cwd: project });
      return { result, contextFiles };
    },
  };
}

test("stripFrontmatter removes only a leading block", () => {
  assert.equal(stripFrontmatter('---\ntools: "*"\n---\nBody'), "Body");
  assert.equal(stripFrontmatter("No frontmatter\n---\nstill body"), "No frontmatter\n---\nstill body");
  assert.equal(stripFrontmatter("---\nunterminated\nBody"), "---\nunterminated\nBody");
  assert.equal(stripFrontmatter("---\npaths: x\n---\n"), "");
});

test("collectRules orders home before project, .claude before .pi, sorted and recursive", () => {
  const projectPi = writeRule(project, ".pi/rules/a.md", "Project pi rule");
  const projectB = writeRule(project, ".claude/rules/b.md", "B rule");
  const projectNested = writeRule(project, ".claude/rules/a/b.md", "Nested rule");
  const projectA = writeRule(project, ".claude/rules/a.md", "A rule");
  const homePi = writeRule(home, ".pi/rules/home-pi.md", "Home pi rule");
  const homeUser = writeRule(home, ".claude/rules/user.md", '---\ntools: "*"\n---\nUser rule');

  assert.deepEqual(collectRules(project), [
    { path: homeUser, content: "User rule" },
    { path: homePi, content: "Home pi rule" },
    { path: projectA, content: "A rule" },
    { path: projectNested, content: "Nested rule" },
    { path: projectB, content: "B rule" },
    { path: projectPi, content: "Project pi rule" },
  ]);
});

test("collectRules follows symlinked rule files and directories", () => {
  const target = writeRule(outside, "shared.md", "Shared rule");
  writeRule(outside, "team/style.md", "Team rule");
  mkdirSync(join(project, ".claude/rules"), { recursive: true });
  const linkedFile = join(project, ".claude/rules/linked.md");
  symlinkSync(target, linkedFile);
  symlinkSync(join(outside, "team"), join(project, ".claude/rules/team"));

  assert.deepEqual(collectRules(project), [
    { path: linkedFile, content: "Shared rule" },
    { path: join(project, ".claude/rules/team/style.md"), content: "Team rule" },
  ]);
});

test("collectRules skips a dangling symlink and loads the rest", () => {
  const kept = writeRule(project, ".claude/rules/rule.md", "Kept");
  symlinkSync(join(outside, "missing"), join(project, ".claude/rules/.#rule.md"));

  assert.deepEqual(collectRules(project), [{ path: kept, content: "Kept" }]);
});

test("collectRules skips non-markdown, frontmatter-only files and missing dirs", () => {
  writeRule(project, ".claude/rules/skip.txt", "not markdown");
  writeRule(project, ".claude/rules/empty.md", "---\npaths: src/**\n---\n  \n");
  const kept = writeRule(project, ".claude/rules/a/b.md", "Kept");

  assert.deepEqual(collectRules(project), [{ path: kept, content: "Kept" }]);
  assert.deepEqual(collectRules(join(outside, "absent-root")), []);
});

test("collectRules dedupes when cwd is the home directory", () => {
  const path = writeRule(home, ".claude/rules/user.md", "User rule");
  assert.deepEqual(collectRules(home), [{ path, content: "User rule" }]);
});

test("collectRules propagates errors other than a missing directory", { skip: process.getuid?.() === 0 }, () => {
  const path = writeRule(project, ".claude/rules/locked.md", "Secret");
  chmodSync(path, 0o000);
  assert.throws(() => collectRules(project), (err) => err.code === "EACCES" && err.message.includes(path));
});

test("handler appends the session_start snapshot after pi's context files", async () => {
  const path = writeRule(project, ".claude/rules/x.md", "Canary v1");
  const extension = loadExtension();
  await extension.sessionStart("startup");

  const agentsMd = { path: join(project, "AGENTS.md"), content: "Agents" };
  const contextFiles = [agentsMd];
  const { result } = await extension.beforeAgentStart(contextFiles);
  assert.equal(result?.systemPrompt, undefined);
  assert.deepEqual(contextFiles, [agentsMd, { path, content: "Canary v1" }]);
});

test("handler keeps the snapshot until the next session_start", async () => {
  const path = writeRule(project, ".claude/rules/x.md", "Canary v1");
  const extension = loadExtension();
  await extension.sessionStart("startup");

  writeFileSync(path, "Canary v2");
  assert.deepEqual((await extension.beforeAgentStart([])).contextFiles, [{ path, content: "Canary v1" }]);

  await extension.sessionStart("new");
  assert.deepEqual((await extension.beforeAgentStart([])).contextFiles, [{ path, content: "Canary v2" }]);
});

test("handler leaves contextFiles unchanged when there are no rules", async () => {
  const extension = loadExtension();
  await extension.sessionStart("startup");
  const agentsMd = { path: join(project, "AGENTS.md"), content: "Agents" };
  const { result, contextFiles } = await extension.beforeAgentStart([agentsMd]);
  assert.equal(result?.systemPrompt, undefined);
  assert.deepEqual(contextFiles, [agentsMd]);
});

test("handler appends the rules to an already-forced prompt and still pushes contextFiles", async () => {
  const a = writeRule(project, ".claude/rules/a.md", "Rule A");
  const b = writeRule(project, ".claude/rules/b.md", "Rule B");
  const extension = loadExtension();
  await extension.sessionStart("startup");

  const { result, contextFiles } = await extension.beforeAgentStart([], "Forced prompt");
  assert.equal(
    result?.systemPrompt,
    "Forced prompt\n\n<project_context>\nProject-specific instructions and guidelines:\n\n" +
      `<project_instructions path="${a}">\nRule A\n</project_instructions>\n\n` +
      `<project_instructions path="${b}">\nRule B\n</project_instructions>\n</project_context>`,
  );
  assert.deepEqual(contextFiles, [
    { path: a, content: "Rule A" },
    { path: b, content: "Rule B" },
  ]);
});

test("handler leaves a forced prompt alone when there are no rules", async () => {
  const extension = loadExtension();
  await extension.sessionStart("startup");
  const { result } = await extension.beforeAgentStart([], "Forced prompt");
  assert.equal(result?.systemPrompt, undefined);
});
