import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RULE_DIRS = [".claude/rules", ".pi/rules"];

/** Drop a leading `---` frontmatter block; scoping keys are meaningless here. */
export function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/** Relative paths of every `*.md` file under `dir`, recursively; [] when `dir` is absent. */
function listMarkdown(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return []; // absent rule directory is the normal case
    throw err;
  }

  const found = [];
  for (const name of names) {
    // statSync follows symlinks, so linked rule files and directories count too.
    let stats;
    try {
      stats = statSync(join(dir, name));
    } catch (err) {
      if (err.code === "ENOENT") continue; // dangling symlink, e.g. an editor lock file
      throw err;
    }
    if (stats.isDirectory()) {
      found.push(...listMarkdown(join(dir, name)).map((nested) => join(name, nested)));
    } else if (stats.isFile() && name.endsWith(".md")) {
      found.push(name);
    }
  }
  return found;
}

/** Read every rule under the home and `cwd` rule directories as context files, in stable order. */
export function collectRules(cwd) {
  const rules = [];
  const seen = new Set();

  for (const root of [homedir(), cwd]) {
    for (const relative of RULE_DIRS) {
      const dir = join(root, relative);
      for (const name of listMarkdown(dir).sort()) {
        const path = join(dir, name);
        if (seen.has(path)) continue; // roots overlap when cwd is the home directory
        seen.add(path);

        const content = stripFrontmatter(readFileSync(path, "utf8"));
        if (content) rules.push({ path, content });
      }
    }
  }

  return rules;
}

/** Render rules the way pi renders its `project_context` section. */
function renderRules(rules) {
  const body = [
    "Project-specific instructions and guidelines:",
    ...rules.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
  return `<project_context>\n${body}\n</project_context>`;
}

export default function rulesExtension(pi) {
  // Snapshot per session, like Claude Code loading rules at the start of every conversation.
  let rules = [];

  pi.on("session_start", async (_event, ctx) => {
    rules = collectRules(ctx.cwd);
  });

  pi.on("before_agent_start", async (event) => {
    if (!rules.length) return;
    const options = event.systemPromptOptions;

    // Push in place: the bridge re-reads this options object by reference.
    options.contextFiles.push(...rules.map((rule) => ({ ...rule })));

    // A forced prompt is sent verbatim, so pushed context files never render for native
    // providers. Only then return `systemPrompt`; the bridge discards a rewritten prompt.
    if (options.forceSystemPrompt !== undefined) {
      return { systemPrompt: `${options.forceSystemPrompt}\n\n${renderRules(rules)}` };
    }
  });
}
