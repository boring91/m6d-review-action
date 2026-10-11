import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PullRequest } from "./types.js";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// A maintainer closes a finding without fixing it by replying
// `@review waive <reason>` in its thread. The bot's closing reply carries this
// marker and opens with WAIVED, and later rounds treat that title as precedent.
export const WAIVED_MARKER = "<!-- codex-waived -->";
export const WAIVED = "Waived by";
export const WAIVE_COMMAND = /^@review\s+waive\b\s*([\s\S]*)$/i;

// The title line inline comments open with, after any snapping note.
const RAISED_TITLE = /(?:^|\n)(?:🔴|🟠|🟡|🔵|🟢) (?:CRITICAL|HIGH|MEDIUM|LOW|INFO) \*\*(.+?)\*\*\n/;

export function raisedTitle(body: unknown): string | undefined {
  return String(body ?? "").match(RAISED_TITLE)?.[1];
}

export function readPrompt(name: string): string {
  return fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
}

export function parseJson<T = unknown>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]) as T;

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }

    throw new Error(`${label} is not JSON.`);
  }
}

export function truncate(value: unknown, max = 2500): string {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

export function quote(value: unknown, max = 2500): string {
  return truncate(value || "(no body)", max)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// Runs git in the checkout and returns its output. Paths are literal, so a
// directory named like pathspec magic (`:/`, `:(glob)`) matches only itself.
export function git(...args: string[]): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Size caps, in characters, on the REVIEW.md text pasted into a prompt.
const RULES_FILE_LIMIT = 20_000;
const RULES_TOTAL_LIMIT = 60_000;

// `prompt` is appended to a Codex prompt, or empty when no rules apply.
// `applied` lists the files that reached it and `cut` the ones shortened or
// left out for size, both root first.
export type Rules = { prompt: string; applied: string[]; cut: string[] };

// The maintainer review rules covering `files`: the REVIEW.md in each file's
// directory and in every directory above it, read at `base`, the commit the
// pull request lands on (`rules_sha` from resolve or validate). Reading them
// there rather than from the checkout means a pull request cannot rewrite the
// rules its own review runs under. Deeper files win on conflict, so they get
// the size budget first and are listed last.
export function reviewRules(base: string, files: string[]): Rules {
  if (files.length === 0) return { prompt: "", applied: [], cut: [] };
  const candidates = new Set(["REVIEW.md"]);
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      candidates.add(`${parts.slice(0, end).join("/")}/REVIEW.md`);
    }
  }

  // Entries read `<mode> <type> <object>\t<path>`. Only regular files hold
  // rules; a symlink would otherwise be applied as its link text.
  const found = git("ls-tree", "-z", base, "--", ...candidates)
    .split("\0")
    .filter((entry) => /^100(?:644|755) blob /.test(entry))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const depth = (file: string) => file.split("/").length;
  found.sort((left, right) => depth(right) - depth(left) || right.localeCompare(left));

  const sections: string[] = [];
  const applied: string[] = [];
  const cut: string[] = [];
  const leftOut: string[] = [];
  let budget = RULES_TOTAL_LIMIT;
  // Deepest first so deeper files claim the budget; unshift lists root first.
  for (const file of found) {
    const text = git("show", `${base}:${file}`).trim();
    const room = Math.min(RULES_FILE_LIMIT, budget);
    if (text.length > room) cut.unshift(file);
    if (!text) continue;
    if (room <= 0) {
      leftOut.unshift(file);
      continue;
    }
    budget -= Math.min(text.length, room);
    const scope =
      file === "REVIEW.md" ? "every file" : `files under \`${path.posix.dirname(file)}/\``;
    sections.unshift(`### \`${file}\` (applies to ${scope})\n\n${quote(text, room)}`);
    applied.unshift(file);
  }

  if (leftOut.length > 0) {
    sections.push(`Left out because of the size limit: ${leftOut.map((file) => `\`${file}\``).join(", ")}.`);
  }
  return {
    prompt: applied.length ? `\n${readPrompt("rules.md")}\n\n${sections.join("\n\n")}\n` : "",
    applied,
    cut,
  };
}

export function isTrustedAssociation(value: unknown): boolean {
  return typeof value === "string" && TRUSTED_ASSOCIATIONS.has(value);
}

export function normalizeBotLogin(value: unknown): string {
  const login = String(value ?? "")
    .trim()
    .replace(/\[bot\]$/i, "")
    .toLowerCase();
  return login ? `${login}[bot]` : "";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Why a pull request must not be reviewed: not open, a draft, from another
// repository, or landing on another branch. A stacked layer lands where its
// stack does, so its own base may be the layer below.
export function pullRequestProblems(
  pr: PullRequest | undefined,
  expectedRepo: string,
  expectedBase: string | undefined,
): string[] {
  const problems = [];
  const landsOn = pr?.stack?.base.ref ?? pr?.base?.ref;
  if (pr?.state !== "open") problems.push(`state is ${pr?.state}`);
  if (pr?.draft) problems.push("PR is a draft");
  if (landsOn !== expectedBase) {
    problems.push(`base is ${landsOn}, expected ${expectedBase}`);
  }
  if (pr?.head?.repo?.full_name !== expectedRepo) {
    problems.push(
      `head repo is ${pr?.head?.repo?.full_name}, expected ${expectedRepo}`,
    );
  }
  return problems;
}
