import * as fs from "node:fs";
import * as path from "node:path";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

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
