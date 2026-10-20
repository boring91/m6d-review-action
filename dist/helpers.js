"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WAIVE_COMMAND = exports.WAIVED = exports.WAIVED_MARKER = void 0;
exports.raisedTitle = raisedTitle;
exports.readPrompt = readPrompt;
exports.parseJson = parseJson;
exports.truncate = truncate;
exports.quote = quote;
exports.git = git;
exports.codeOwners = codeOwners;
exports.reviewRules = reviewRules;
exports.isTrustedAssociation = isTrustedAssociation;
exports.normalizeBotLogin = normalizeBotLogin;
exports.errorMessage = errorMessage;
exports.pullRequestProblems = pullRequestProblems;
exports.startReview = startReview;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// A maintainer closes a finding without fixing it by replying
// `@review waive <reason>` in its thread. The bot's closing reply carries this
// marker and opens with WAIVED, and later rounds treat that title as precedent.
exports.WAIVED_MARKER = "<!-- codex-waived -->";
exports.WAIVED = "Waived by";
exports.WAIVE_COMMAND = /^@review\s+waive\b\s*([\s\S]*)$/i;
// The title line inline comments open with, after any snapping note.
const RAISED_TITLE = /(?:^|\n)(?:🔴|🟠|🟡|🔵|🟢) (?:CRITICAL|HIGH|MEDIUM|LOW|INFO) \*\*(.+?)\*\*\n/;
function raisedTitle(body) {
    return String(body ?? "").match(RAISED_TITLE)?.[1];
}
function readPrompt(name) {
    return fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
}
function parseJson(raw, label) {
    try {
        return JSON.parse(raw);
    }
    catch {
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced)
            return JSON.parse(fenced[1]);
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start !== -1 && end > start) {
            return JSON.parse(raw.slice(start, end + 1));
        }
        throw new Error(`${label} is not JSON.`);
    }
}
function truncate(value, max = 2500) {
    const text = String(value ?? "").trim();
    return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}
function quote(value, max = 2500) {
    return truncate(value || "(no body)", max)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
}
// Runs git in the checkout and returns its output. Paths are literal, so a
// directory named like pathspec magic (`:/`, `:(glob)`) matches only itself.
function git(...args) {
    return (0, node_child_process_1.execFileSync)("git", ["--literal-pathspecs", ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
}
// The `paths` that are regular files at `base`. Entries read
// `<mode> <type> <object>\t<path>`; a symlink would otherwise be read as its
// link text.
function filesAt(base, paths) {
    return git("ls-tree", "-z", base, "--", ...paths)
        .split("\0")
        .filter((entry) => /^100(?:644|755) blob /.test(entry))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}
// Where GitHub looks for CODEOWNERS, in the order it picks the first found.
const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
// Lowercased logins named in the CODEOWNERS file, read at `base` like the
// review rules so a pull request cannot list its own author. Team and email
// owners are skipped, and an owner of any path counts for every path.
function codeOwners(base) {
    const found = filesAt(base, CODEOWNERS_FILES);
    const file = CODEOWNERS_FILES.find((candidate) => found.includes(candidate));
    if (!file)
        return [];
    return git("show", `${base}:${file}`)
        .split("\n")
        .flatMap((line) => line.replace(/#.*/, "").trim().split(/\s+/).slice(1))
        .flatMap((owner) => owner.match(/^@([\w-]+)$/)?.[1].toLowerCase() ?? []);
}
// Size caps, in characters, on the REVIEW.md text pasted into a prompt.
const RULES_FILE_LIMIT = 20_000;
const RULES_TOTAL_LIMIT = 60_000;
// The maintainer review rules covering `files`: the REVIEW.md in each file's
// directory and in every directory above it, read at `base`, the commit the
// pull request lands on (`rules_sha` from resolve or validate). Reading them
// there rather than from the checkout means a pull request cannot rewrite the
// rules its own review runs under. Deeper files win on conflict, so they get
// the size budget first and are listed last.
function reviewRules(base, files) {
    if (files.length === 0)
        return { prompt: "", applied: [], cut: [] };
    const candidates = new Set(["REVIEW.md"]);
    for (const file of files) {
        const parts = file.split("/");
        for (let end = 1; end < parts.length; end += 1) {
            candidates.add(`${parts.slice(0, end).join("/")}/REVIEW.md`);
        }
    }
    const found = filesAt(base, candidates);
    const depth = (file) => file.split("/").length;
    found.sort((left, right) => depth(right) - depth(left) || right.localeCompare(left));
    const sections = [];
    const applied = [];
    const cut = [];
    const leftOut = [];
    let budget = RULES_TOTAL_LIMIT;
    // Deepest first so deeper files claim the budget; unshift lists root first.
    for (const file of found) {
        const text = git("show", `${base}:${file}`).trim();
        const room = Math.min(RULES_FILE_LIMIT, budget);
        if (text.length > room)
            cut.unshift(file);
        if (!text)
            continue;
        if (room <= 0) {
            leftOut.unshift(file);
            continue;
        }
        budget -= Math.min(text.length, room);
        const scope = file === "REVIEW.md" ? "every file" : `files under \`${path.posix.dirname(file)}/\``;
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
function isTrustedAssociation(value) {
    return typeof value === "string" && TRUSTED_ASSOCIATIONS.has(value);
}
function normalizeBotLogin(value) {
    const login = String(value ?? "")
        .trim()
        .replace(/\[bot\]$/i, "")
        .toLowerCase();
    return login ? `${login}[bot]` : "";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// Why a pull request must not be reviewed: not open, a draft, from another
// repository, or landing on another branch. A stacked layer lands where its
// stack does, so its own base may be the layer below.
function pullRequestProblems(pr, expectedRepo, expectedBase) {
    const problems = [];
    const landsOn = pr?.stack?.base.ref ?? pr?.base?.ref;
    if (pr?.state !== "open")
        problems.push(`state is ${pr?.state}`);
    if (pr?.draft)
        problems.push("PR is a draft");
    if (landsOn !== expectedBase) {
        problems.push(`base is ${landsOn}, expected ${expectedBase}`);
    }
    if (pr?.head?.repo?.full_name !== expectedRepo) {
        problems.push(`head repo is ${pr?.head?.repo?.full_name}, expected ${expectedRepo}`);
    }
    return problems;
}
// Starts a full review of the PR's current head. Re-running the head's last
// pull_request review puts the result on the commit the PR's check list
// shows; a dispatched run reports on the default branch's tip, where the PR
// never sees it. A run that hasn't finished is left alone, because a dispatch
// would cancel it through the review workflow's concurrency group. It may
// have read the threads before this request, so the user comments `@review`
// after it finishes if it missed a reply or waiver. Dispatch is the fallback
// when the head's last run is missing or skipped, has reached 50 attempts
// (GitHub caps re-runs at 50), or GitHub refuses the re-run, as it does 30
// days after the run started.
async function startReview({ github, context, core }, pullNumber) {
    const { owner, repo } = context.repo;
    const workflow = process.env.M6D_REVIEW_WORKFLOW || "review.yml";
    const { head } = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data;
    // Filtering by branch skips another PR's run when its branch points at the
    // same commit.
    let [run] = (await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
        event: "pull_request",
        branch: head.ref,
        head_sha: head.sha,
        per_page: 1,
    })).data.workflow_runs;
    if (run?.status === "completed" && run.conclusion !== "skipped" && run.run_attempt < 50) {
        try {
            await github.rest.actions.reRunWorkflow({ owner, repo, run_id: run.id });
            core.info(`Re-running review run ${run.id} on ${head.sha.slice(0, 7)}.`);
            return;
        }
        catch (error) {
            // A concurrent request may have just re-run it, which refuses this one.
            run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id }))
                .data;
            if (run.status === "completed") {
                core.warning(`Could not re-run review run ${run.id}: ${errorMessage(error)}`);
            }
        }
    }
    if (run && run.status !== "completed") {
        core.notice(`Review run ${run.id} on ${head.sha.slice(0, 7)} has not finished; leaving it to review the head.`);
        return;
    }
    const defaultBranch = context.payload.repository?.default_branch;
    if (!defaultBranch)
        throw new Error("Repository default branch is unavailable.");
    core.info(`Dispatching ${workflow} on ${defaultBranch}.`);
    await github.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflow,
        ref: defaultBranch,
        inputs: { pr_number: String(pullNumber) },
    });
}
