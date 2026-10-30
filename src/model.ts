import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { codeOwners, errorMessage } from "./helpers.js";
import type { HandlerOptions } from "./types.js";

// Every Codex call of a review. action.yml runs this file from shell steps
// with the runner's own Node (`<node> dist/model.js <step>`), never inside
// github-script: a github-script process holds the app token in its
// environment, and Codex, running with full access on untrusted pull-request
// text, could read it through /proc. A step still rate limited after its
// tries names why in its `limited` output, and a later github-script step
// posts the notice.

// One Codex call: it reads `prompt` and writes JSON matching `schema` to `output`.
type ModelCall = {
  effort: "high" | "medium";
  schema: string;
  output: string;
  prompt: string;
};

// What a step's calls came to: every failure, and the Codex error of each call
// still limited after its tries.
type Outcome = { failures: string[]; limited: string[] };

const TRIES = 3;
const COOL_OFF_SECONDS = 300;
// Characters of Codex's error the notice quotes.
const REASON_LIMIT = 200;
// Codex prints errors as `ERROR: ...` lines. The rest of its output echoes the
// prompt and the session, which may mention limits of their own.
const LIMITED = /(?:^|\D)429(?:\D|$)|rate.?limit|usage limit|capacity|overloaded|too many requests/i;

// A call Codex still reported as limited on its last try.
class ModelLimited extends Error {
  constructor(readonly reason: string) {
    super(`gpt-6.1-sol was still limited after ${TRIES} tries: ${reason}`);
  }
}

// Runs Codex once on `call`, answering its exit code and everything it
// printed. `echo` sees the output as it arrives.
function codex(
  call: ModelCall,
  echo: (chunk: string) => void,
): Promise<{ code: number; printed: string }> {
  const prompt = fs.readFileSync(call.prompt);
  // A try that failed may have left output behind; only this try's counts.
  fs.rmSync(call.output, { force: true });
  const child = spawn("codex", [
    "exec",
    "--model",
    "gpt-6.1-sol",
    "-c",
    `model_reasoning_effort="${call.effort}"`,
    "--ephemeral",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    "--output-schema",
    call.schema,
    "-o",
    call.output,
    "-",
  ]);
  let printed = "";
  const record = (chunk: string) => {
    printed += chunk;
    echo(chunk);
  };
  child.stdout.setEncoding("utf8").on("data", record);
  child.stderr.setEncoding("utf8").on("data", record);
  // Codex may exit before it reads the whole prompt; its exit code says why.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return new Promise((resolve) => {
    // Codex could not start, such as when it is missing from PATH.
    child.on("error", (error) => {
      const line = `ERROR: ${error.message}\n`;
      echo(line);
      resolve({ code: 127, printed: printed + line });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, printed }));
  });
}

// Runs one call. When Codex reports a rate limit, a usage limit or a lack of
// capacity, it waits `coolOff` seconds and tries again, three tries in all;
// any other failure throws at once.
async function runModel(
  call: ModelCall,
  coolOff: number,
  echo: (chunk: string) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const { code, printed } = await codex(call, echo);
    if (code === 0 && fs.existsSync(call.output) && fs.statSync(call.output).size > 0) return;
    const reason = printed
      .split("\n")
      .find((line) => line.startsWith("ERROR: ") && LIMITED.test(line))
      ?.slice("ERROR: ".length)
      .slice(0, REASON_LIMIT);
    if (!reason) throw new Error(`gpt-6.1-sol failed on ${call.prompt} (exit ${code}).`);
    if (attempt === TRIES) throw new ModelLimited(reason);
    echo(`gpt-6.1-sol is limited (${reason}); trying again in ${coolOff}s.\n`);
    await sleep(coolOff * 1000);
  }
}

// Runs `calls` in parallel. A lone call streams its output; parallel ones
// print theirs when each finishes, so they never interleave.
async function runModels(calls: ModelCall[], coolOff: number): Promise<Outcome> {
  const results = await Promise.allSettled(
    calls.map(async (call) => {
      if (calls.length === 1) {
        return runModel(call, coolOff, (chunk) => process.stdout.write(chunk));
      }
      let printed = "";
      try {
        await runModel(call, coolOff, (chunk) => (printed += chunk));
      } finally {
        console.log(`::group::${path.basename(call.prompt)}\n${printed.trimEnd()}\n::endgroup::`);
      }
    }),
  );
  const outcome: Outcome = { failures: [], limited: [] };
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    outcome.failures.push(errorMessage(result.reason));
    if (result.reason instanceof ModelLimited) outcome.limited.push(result.reason.reason);
  }
  return outcome;
}

// The single call of a step that asks Codex one thing at high reasoning.
function single(name: string): ModelCall {
  return {
    effort: "high",
    schema: `.codex/${name}-schema.json`,
    output: `.codex/${name}.json`,
    prompt: `.codex/${name}-prompt.md`,
  };
}

// Each step's calls, by the name action.yml passes.
const STEPS = new Map<string, (coolOff: number) => Promise<Outcome>>([
  // The finder prompts prepare wrote run in parallel: one for standard, four
  // for thorough plus a rules finder when a REVIEW.md covers the diff. Any
  // finder failure fails the review. Then the verifier confirms or drops every
  // candidate and writes the final review. Finders run at high reasoning
  // because recall drops sharply below it; the verifier runs at medium, which
  // on the same candidates keeps every HIGH and MEDIUM finding at roughly half
  // the wall time.
  [
    "review",
    async (coolOff) => {
      const prompts = fs.existsSync(".codex/finders")
        ? fs.readdirSync(".codex/finders").filter((file) => file.endsWith(".md")).sort()
        : [];
      if (prompts.length === 0) return { failures: ["Prepare wrote no finder prompts."], limited: [] };
      fs.mkdirSync(".codex/candidates", { recursive: true });
      const found = await runModels(
        prompts.map((file) => ({
          effort: "high",
          schema: ".codex/candidates-schema.json",
          output: `.codex/candidates/${file.slice(0, -".md".length)}.json`,
          prompt: `.codex/finders/${file}`,
        })),
        coolOff,
      );
      if (found.failures.length > 0) return found;
      return runModels([{ ...single("review"), effort: "medium" }], coolOff);
    },
  ],
  // The open threads the verifier skipped, from what checkThreads wrote.
  ["threads", (coolOff) => runModels([single("threads")], coolOff)],
  // The reply under evaluation, from what reply.prepare wrote.
  ["reply", (coolOff) => runModels([single("reply")], coolOff)],
]);

// Runs step `name` and answers its exit code: 1 when any call failed. The
// errors of calls still limited go to the step's `limited` output.
export async function runStep(name: string, coolOff = COOL_OFF_SECONDS): Promise<number> {
  const step = STEPS.get(name);
  if (!step) {
    console.error(`Unknown model step "${name}"; expected one of: ${[...STEPS.keys()].join(", ")}.`);
    return 2;
  }
  const { failures, limited } = await step(coolOff);
  for (const failure of failures) console.error(`::error::${failure}`);
  if (limited.length > 0 && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `limited=${[...new Set(limited)].join("; ")}\n`);
  }
  return failures.length > 0 ? 1 : 0;
}

if (require.main === module) {
  void runStep(process.argv[2] ?? "").then((code) => {
    process.exitCode = code;
  });
}

// Tells the owners that a step failed because gpt-6.1-sol stayed rate limited
// through every try, so a blocked review never waits unnoticed. M6D_LIMITED is
// that step's `limited` output. One pull-request comment mentions the `notify`
// input's logins or, by default, the CODEOWNERS users read at the base commit.
export async function notifyRateLimit({ github, context, core }: HandlerOptions): Promise<void> {
  const reasons = process.env.M6D_LIMITED || "";
  if (!reasons) return;
  const configured = [
    ...new Set(
      (process.env.M6D_NOTIFY || "")
        .split(",")
        .map((login) => login.trim().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
  const rulesSha = process.env.M6D_RULES_SHA || "";
  const logins = configured.length || !rulesSha ? configured : codeOwners(rulesSha);
  const headSha = (process.env.M6D_HEAD_SHA || "").slice(0, 7);
  const body = [
    logins.map((login) => `@${login}`).join(" "),
    `This run${headSha ? ` on ${headSha}` : ""} failed: gpt-6.1-sol was still rate limited (${reasons}) after ${TRIES} tries. Re-run the job once the limit resets.`,
  ]
    .filter(Boolean)
    .join(" ");
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: Number(process.env.M6D_PR_NUMBER),
    body,
  });
  core.warning(`gpt-6.1-sol was still rate limited after ${TRIES} tries: ${reasons}`);
}
