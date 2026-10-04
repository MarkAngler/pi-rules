# pi-rules

Loads Claude Code-style rule files into pi's context, so the same `.claude/rules` work in pi.

## Install

```sh
pi install npm:@mangler/pi-rules
```

## What gets loaded

In this order:

1. `~/.claude/rules`
2. `~/.pi/rules`
3. `<cwd>/.claude/rules`
4. `<cwd>/.pi/rules`

Within each directory, every `*.md` file is loaded, recursively, sorted by relative path. Symlinked files and directories are followed; broken symlinks are skipped. A leading YAML frontmatter block is stripped, and files that are empty afterwards are skipped. When `cwd` is the home directory, each file loads once.

Rules are appended after pi's own context files (e.g. `AGENTS.md`).

## When

Rules are read once when a session starts. After editing a rule, start a new session (`/new`) or run `/reload` to pick it up.

## Differences from Claude Code

- `paths:` frontmatter is ignored, so every rule is always loaded. Claude Code loads a [path-scoped rule](https://code.claude.com/docs/en/memory#path-specific-rules) only when it reads, writes, or edits a matching file.
- It also reads `.pi/rules`, which Claude Code does not.

## When another extension replaces the system prompt

If an extension that runs before this one replaces the system prompt (by returning `systemPrompt` from `before_agent_start`), pi sends that prompt verbatim without context files, so the rules are also appended to it as a `<project_context>` block. pi-claude-bridge ignores replaced prompts and receives the rules as context files.

## Development

```sh
npm test
```

Uses Node's built-in test runner; there are no dependencies.

## Releasing

Run `npm version patch|minor|major`, then `git push --follow-tags`. The Publish workflow publishes the `v*` tag to npm via trusted publishing, with provenance.

## License

MIT
