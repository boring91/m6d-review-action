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
exports.resolve = resolve;
exports.prepare = prepare;
exports.checkThreads = checkThreads;
exports.parseDiffLines = parseDiffLines;
exports.inlineComments = inlineComments;
exports.similarTitles = similarTitles;
exports.scopeComments = scopeComments;
exports.submit = submit;
exports.finish = finish;
const fs = __importStar(require("node:fs"));
const helpers_js_1 = require("./helpers.js");
const MARKER = "<!-- codex-review-status -->";
const SEVERITY = {
    CRITICAL: "🔴 CRITICAL",
    HIGH: "🟠 HIGH",
    MEDIUM: "🟡 MEDIUM",
    LOW: "🔵 LOW",
    INFO: "🟢 INFO",
};
const OPEN_THREADS_FILE = ".codex/open-threads.json";
// Written by prepare on a re-review: the commit the bot last reviewed and the
// GitHub compare-API files changed since. Absent on a first review or when the
// history diverged (force push), in which case the whole diff is in scope.
const INCREMENTAL_FILE = ".codex/incremental.json";
// Titles of every candidate an earlier round listed under "Considered and
// dropped". A later round may not re-raise one unless the code it sits on
// changed since that decision.
const PRECEDENT_FILE = ".codex/precedent.json";
async function resolve({ github, context, core, }) {
    const { owner, repo } = context.repo;
    const pullRequest = context.payload.pull_request ??
        (await github.rest.pulls.get({
            owner,
            repo,
            pull_number: Number(process.env.M6D_PR_NUMBER),
        })).data;
    const expectedRepo = `${owner}/${repo}`;
    const expectedBase = process.env.M6D_BASE_BRANCH;
    const problems = [];
    if (pullRequest.state !== "open")
        problems.push(`state is ${pullRequest.state}`);
    if (pullRequest.draft)
        problems.push("PR is a draft");
    if (pullRequest.base?.ref !== expectedBase) {
        problems.push(`base is ${pullRequest.base?.ref}, expected ${expectedBase}`);
    }
    if (pullRequest.head?.repo?.full_name !== expectedRepo) {
        problems.push(`head repo is ${pullRequest.head?.repo?.full_name}, expected ${expectedRepo}`);
    }
    if (problems.length > 0) {
        core.setFailed(`Refusing to review PR #${pullRequest.number}: ${problems.join("; ")}.`);
        return;
    }
    core.setOutput("number", String(pullRequest.number));
    core.setOutput("head_sha", pullRequest.head.sha);
    core.setOutput("base_ref", pullRequest.base.ref);
    core.setOutput("base_sha", pullRequest.base.sha);
    core.setOutput("title", pullRequest.title ?? "");
}
// The verifier confirms or drops every candidate before anything reaches the
// PR. A thorough review gives each dimension its own finder session; a
// standard review covers all four in one.
const DIMENSIONS = {
    correctness: "Correctness and reliability: broken workflows, regressions, edge cases, state transitions, concurrency, error handling, data integrity, and compatibility.",
    security: "Security and trust boundaries: authentication, authorization, ownership and tenant isolation, input validation, injection, data exposure, secrets, unsafe configuration, and dependency risks.",
    minimality: "Minimality and reuse: existing code that can be reused, duplicated logic, unnecessary dependencies or abstractions, scope creep, and materially smaller implementations. Optimize for fewer concepts, branches, dependencies, and duplicated paths rather than raw line count.",
    taste: "Taste and consistency: naming, readability, language idioms, API shape, error-handling conventions, code smells, UI consistency, and alignment with established repository patterns.",
};
function finders(level) {
    if (level === "thorough")
        return DIMENSIONS;
    return {
        review: Object.values(DIMENSIONS)
            .map((dimension) => `- ${dimension}`)
            .join("\n"),
    };
}
// Shared by finder candidates and final inline comments.
const commentFields = {
    title: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    line: { type: "integer", minimum: 1 },
    side: { type: "string", enum: ["RIGHT", "LEFT"] },
    start_line: { type: ["integer", "null"], minimum: 1 },
    start_side: { type: ["string", "null"], enum: ["RIGHT", "LEFT", null] },
    severity: { type: "string", enum: Object.keys(SEVERITY) },
    body: { type: "string", minLength: 1 },
};
function candidatesSchema() {
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["candidates"],
        properties: {
            candidates: {
                type: "array",
                maxItems: 50,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: [...Object.keys(commentFields), "evidence"],
                    properties: {
                        ...commentFields,
                        evidence: { type: "array", items: { type: "string", minLength: 1 } },
                    },
                },
            },
        },
    };
}
// The thread IDs are baked into the schema so structured output forces one
// decision per open thread instead of letting the model skip some.
function threadsSchema(threadIds) {
    return {
        type: "array",
        minItems: threadIds.length,
        maxItems: Math.max(threadIds.length, 1),
        items: {
            type: "object",
            additionalProperties: false,
            required: ["thread_id", "status", "reply"],
            properties: {
                thread_id: { type: "string", enum: threadIds.length ? threadIds : [""] },
                status: { type: "string", enum: ["FIXED", "NOT_APPLICABLE", "OPEN"] },
                reply: { type: ["string", "null"] },
            },
        },
    };
}
function threadsRetrySchema(threadIds) {
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["threads"],
        properties: { threads: threadsSchema(threadIds) },
    };
}
function reviewSchema(threadIds) {
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: [
            "event",
            "merge_decision",
            "quality_score",
            "review_completed",
            "failure_reason",
            "body",
            "comments",
            "dropped",
            "threads",
        ],
        properties: {
            event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES"] },
            merge_decision: { type: "string", enum: ["MERGE", "DO_NOT_MERGE"] },
            quality_score: { type: "integer", minimum: 1, maximum: 10 },
            review_completed: { type: "boolean" },
            failure_reason: { type: ["string", "null"] },
            body: { type: "string", minLength: 1 },
            comments: {
                type: "array",
                maxItems: 50,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: Object.keys(commentFields),
                    properties: commentFields,
                },
            },
            dropped: {
                type: "array",
                maxItems: 200,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "reason"],
                    properties: {
                        title: { type: "string", minLength: 1 },
                        reason: { type: "string", minLength: 1 },
                    },
                },
            },
            threads: threadsSchema(threadIds),
        },
    };
}
function finderPrompt(repository, dimension) {
    return (0, helpers_js_1.readPrompt)("finder.md")
        .replace("{{repository}}", repository)
        .replace("{{dimension}}", dimension);
}
async function listThreads(github, owner, repo, pullNumber) {
    const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              originalLine
              originalStartLine
              diffSide
              comments(first: 100) {
                nodes { ...commentFields }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
    ${COMMENT_FIELDS}`;
    const nodes = [];
    let cursor = null;
    do {
        const result = await github.graphql(query, {
            owner,
            repo,
            number: pullNumber,
            cursor,
        });
        const threads = result.repository.pullRequest.reviewThreads;
        for (const thread of threads.nodes) {
            // A thread's own comments page too; a long back-and-forth must not
            // hide the reply that explains why a finding was wrong.
            let page = thread.comments;
            while (page.pageInfo?.hasNextPage) {
                page = await github
                    .graphql(`query($id: ID!, $cursor: String) {
               node(id: $id) {
                 ... on PullRequestReviewThread {
                   comments(first: 100, after: $cursor) {
                     nodes { ...commentFields }
                     pageInfo { hasNextPage endCursor }
                   }
                 }
               }
             }
             ${COMMENT_FIELDS}`, { id: thread.id, cursor: page.pageInfo.endCursor })
                    .then((result) => result.node.comments);
                thread.comments.nodes.push(...page.nodes);
            }
            nodes.push(thread);
        }
        cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);
    return nodes;
}
const COMMENT_FIELDS = `
  fragment commentFields on PullRequestReviewComment {
    databaseId
    author { login }
    body
    createdAt
    path
    line
    originalLine
  }`;
async function upsertStatus(github, owner, repo, pullNumber, body) {
    const appSlug = process.env.M6D_APP_SLUG;
    if (!appSlug)
        throw new Error("GitHub App slug is unavailable.");
    const comments = await github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
    });
    const appLogin = (0, helpers_js_1.normalizeBotLogin)(appSlug);
    const existing = comments.find((comment) => comment.body?.includes(MARKER) &&
        (comment.performed_via_github_app?.slug === appSlug ||
            (0, helpers_js_1.normalizeBotLogin)(comment.user?.login) === appLogin));
    if (existing) {
        await github.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existing.id,
            body,
        });
        return;
    }
    await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
    });
}
async function prepare({ github, context, }) {
    const { owner, repo } = context.repo;
    const pullRequest = context.payload.pull_request ??
        (await github.rest.pulls.get({
            owner,
            repo,
            pull_number: Number(process.env.M6D_PR_NUMBER),
        })).data;
    const pullNumber = pullRequest.number;
    await upsertStatus(github, owner, repo, pullNumber, [
        MARKER,
        "## Codex Review",
        "",
        `Codex is reviewing commit \`${(process.env.M6D_HEAD_SHA || "").slice(0, 7)}\`.`,
        "",
        "This comment is updated on each push.",
    ].join("\n"));
    const [reviews, issueComments, threads] = await Promise.all([
        github.paginate(github.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
        }),
        github.paginate(github.rest.issues.listComments, {
            owner,
            repo,
            issue_number: pullNumber,
            per_page: 100,
        }),
        listThreads(github, owner, repo, pullNumber),
    ]);
    const contextLines = [
        "# Pull Request Context",
        "",
        `PR: #${pullNumber} ${pullRequest.title}`,
        `Author: ${pullRequest.user.login}`,
        `Base: ${pullRequest.base.ref} (${pullRequest.base.sha})`,
        `Head: ${pullRequest.head.ref} (${pullRequest.head.sha})`,
        `Review bot: ${process.env.M6D_APP_SLUG}[bot]`,
        "",
        "## PR Description",
        "",
        (0, helpers_js_1.quote)(pullRequest.body || "(no description)"),
        "",
        "## Prior Review Bodies",
        "",
    ];
    const bodies = reviews.filter((review) => review.body).slice(-20);
    if (bodies.length === 0)
        contextLines.push("No prior review bodies found.");
    for (const review of bodies) {
        contextLines.push(`### ${review.user.login} ${review.state} at ${review.submitted_at}`, "", (0, helpers_js_1.quote)(review.body), "");
    }
    contextLines.push("", "## Prior Review Threads", "");
    if (threads.length === 0)
        contextLines.push("No prior review threads found.");
    for (const [index, thread] of threads.entries()) {
        const comments = thread.comments.nodes;
        const first = comments[0] ?? {};
        const file = thread.path ?? first.path ?? "unknown";
        const line = thread.line ??
            thread.originalLine ??
            first.line ??
            first.originalLine ??
            "unknown";
        contextLines.push(`### Thread ${index + 1}: ${thread.isResolved ? "resolved" : "unresolved"}, ${thread.isOutdated ? "outdated" : "current"}`, `Thread ID: ${thread.id}`, `File: ${file}:${line}`, `Side: ${thread.diffSide ?? "unknown"}`);
        if (thread.startLine || thread.originalStartLine) {
            contextLines.push(`Range start: ${thread.startLine ?? thread.originalStartLine}`);
        }
        for (const comment of comments) {
            contextLines.push("", `Comment by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}`, "", (0, helpers_js_1.quote)(comment.body));
        }
        contextLines.push("");
    }
    contextLines.push("", "## Prior Conversation Comments", "");
    const recentComments = issueComments
        .filter((comment) => !comment.body?.includes(MARKER))
        .slice(-20);
    if (recentComments.length === 0) {
        contextLines.push("No prior conversation comments found.");
    }
    for (const comment of recentComments) {
        contextLines.push(`### ${comment.user.login} at ${comment.created_at}`, "", (0, helpers_js_1.quote)(comment.body), "");
    }
    const repository = `${owner}/${repo}`;
    const appLogin = (0, helpers_js_1.normalizeBotLogin)(process.env.M6D_APP_SLUG);
    const botReviews = reviews.filter((review) => (0, helpers_js_1.normalizeBotLogin)(review.user?.login) === appLogin);
    // Only genuine rejections are precedent. A candidate the verifier merged
    // into a confirmed finding was a duplicate of something real, and blocking
    // its wording later could suppress that finding's own follow-ups.
    const precedent = botReviews.flatMap((review) => [...String(review.body ?? "").matchAll(/^- \*\*(.+?)\*\*: (.*)$/gm)]
        .filter((match) => !/^merged (into|with)\b/i.test(match[2]))
        .map((match) => match[1]));
    const incremental = await incrementalScope(github, owner, repo, botReviews.map((review) => review.commit_id).filter(Boolean).pop(), process.env.M6D_HEAD_SHA);
    const target = [
        "",
        "Runtime review target:",
        `- PR title: ${process.env.M6D_PR_TITLE}`,
        `- Base ref: ${process.env.M6D_BASE_REF}`,
        `- Base SHA: ${process.env.M6D_BASE_SHA}`,
        `- Head SHA: ${process.env.M6D_HEAD_SHA}`,
        `- Full PR diff: git diff ${process.env.M6D_BASE_SHA}...${process.env.M6D_HEAD_SHA}`,
        ...(incremental
            ? [
                `- Previously reviewed head: ${incremental.previous_head}`,
                `- Changed since the last review: git diff ${incremental.previous_head}...${process.env.M6D_HEAD_SHA}`,
                `- Files changed since the last review: ${incremental.files.map((file) => file.filename).join(", ")}`,
            ]
            : ["- This is the first review of this pull request."]),
        "",
    ].join("\n");
    const openThreadIds = threads
        .filter((thread) => !thread.isResolved &&
        (0, helpers_js_1.normalizeBotLogin)(thread.comments.nodes[0]?.author?.login) === appLogin)
        .map((thread) => thread.id);
    // The checkout is untrusted PR content. Start from an empty .codex so a PR
    // cannot plant extra finder prompts, fake candidates, or symlinked logs.
    fs.rmSync(".codex", { recursive: true, force: true });
    fs.mkdirSync(".codex/finders", { recursive: true });
    fs.writeFileSync(".codex/pr-context.md", `${contextLines.join("\n")}\n`, "utf8");
    fs.writeFileSync(OPEN_THREADS_FILE, `${JSON.stringify(openThreadIds)}\n`, "utf8");
    fs.writeFileSync(PRECEDENT_FILE, `${JSON.stringify(precedent)}\n`, "utf8");
    if (incremental) {
        fs.writeFileSync(INCREMENTAL_FILE, `${JSON.stringify(incremental)}\n`, "utf8");
    }
    fs.writeFileSync(".codex/candidates-schema.json", `${JSON.stringify(candidatesSchema(), null, 2)}\n`, "utf8");
    fs.writeFileSync(".codex/review-schema.json", `${JSON.stringify(reviewSchema(openThreadIds), null, 2)}\n`, "utf8");
    for (const [key, dimension] of Object.entries(finders(process.env.M6D_REVIEW_LEVEL))) {
        fs.writeFileSync(`.codex/finders/${key}.md`, `${finderPrompt(repository, dimension)}\n${target}`, "utf8");
    }
    fs.writeFileSync(".codex/review-prompt.md", `${(0, helpers_js_1.readPrompt)("verify.md").replace("{{repository}}", repository)}\n${target}`, "utf8");
}
// On a re-review, the diff between the last bot-reviewed commit and the current
// head. Returns undefined on a first review, after a force push, or when the
// compare is too large to trust, so the caller falls back to the full diff.
async function incrementalScope(github, owner, repo, previousHead, head) {
    if (!previousHead || !head || previousHead === head)
        return undefined;
    try {
        const { data } = await github.rest.repos.compareCommits({
            owner,
            repo,
            base: previousHead,
            head,
            per_page: 300,
        });
        if (data.status !== "ahead" || !data.files || data.files.length >= 300) {
            return undefined;
        }
        return {
            previous_head: previousHead,
            files: data.files.map((file) => ({
                filename: file.filename,
                patch: file.patch ?? null,
            })),
        };
    }
    catch {
        return undefined;
    }
}
// Runs after the verifier. If it skipped any open thread despite the schema,
// write a retry prompt and schema covering only the missed IDs and signal the
// workflow to run Codex once more. Missed threads after that stay OPEN.
async function checkThreads({ context, core, }) {
    const expected = JSON.parse(fs.readFileSync(OPEN_THREADS_FILE, "utf8"));
    const review = (0, helpers_js_1.parseJson)(fs.readFileSync(".codex/review.json", "utf8").trim(), "Codex review output");
    const decided = new Set((Array.isArray(review.threads) ? review.threads : []).map((entry) => entry.thread_id));
    const missing = expected.filter((id) => !decided.has(id));
    core.setOutput("retry", missing.length > 0 ? "true" : "false");
    if (missing.length === 0)
        return;
    core.warning(`Verifier skipped ${missing.length} open thread(s); retrying once for: ${missing.join(", ")}`);
    fs.writeFileSync(".codex/threads-schema.json", `${JSON.stringify(threadsRetrySchema(missing), null, 2)}\n`, "utf8");
    fs.writeFileSync(".codex/threads-prompt.md", [
        (0, helpers_js_1.readPrompt)("threads.md").replace("{{repository}}", `${context.repo.owner}/${context.repo.repo}`),
        "",
        "Threads to classify:",
        ...missing.map((id) => `- ${id}`),
        "",
        `Compare with: git diff ${process.env.M6D_BASE_SHA}...${process.env.M6D_HEAD_SHA}`,
        "",
    ].join("\n"), "utf8");
}
function normalizePath(value) {
    return String(value ?? "")
        .trim()
        .replace(/^[ab]\//, "");
}
function commentBody(comment) {
    const key = SEVERITY[comment.severity]
        ? comment.severity
        : "MEDIUM";
    const label = SEVERITY[key];
    const body = (0, helpers_js_1.truncate)(comment.body, 4000);
    return body ? (body.startsWith(label) ? body : `${label}\n\n${body}`) : "";
}
// Walk each file's unified-diff patch and record which LEFT (base) and RIGHT
// (head) line numbers fall inside a hunk. Files without a patch (binary, too
// large) are present with empty sets so they still qualify for file comments.
function parseDiffLines(files) {
    const result = new Map();
    for (const file of files) {
        const lines = { LEFT: new Set(), RIGHT: new Set() };
        result.set(file.filename, lines);
        if (!file.patch)
            continue;
        let inHunk = false;
        let left = 0;
        let right = 0;
        for (const raw of file.patch.replace(/\n$/, "").split("\n")) {
            const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunk) {
                inHunk = true;
                left = Number(hunk[1]);
                right = Number(hunk[2]);
                continue;
            }
            if (!inHunk)
                continue;
            if (raw.startsWith("-")) {
                lines.LEFT.add(left++);
            }
            else if (raw.startsWith("+")) {
                lines.RIGHT.add(right++);
            }
            else if (raw.startsWith(" ") || raw === "") {
                lines.LEFT.add(left++);
                lines.RIGHT.add(right++);
            }
        }
    }
    return result;
}
function nearest(candidates, target) {
    let best;
    for (const value of candidates) {
        if (best === undefined || Math.abs(value - target) < Math.abs(best - target)) {
            best = value;
        }
    }
    return best;
}
// Turn model comments into payloads GitHub will accept. Lines outside the diff
// snap to the nearest reviewable line in the same file; files outside the diff
// become file-level comments. Nothing verified is dropped over a position.
function inlineComments(source, diff) {
    const result = {
        comments: [],
        omitted: 0,
    };
    for (const comment of source) {
        const path = normalizePath(comment.path);
        const body = commentBody(comment);
        const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
        const line = Number(comment.line);
        if (!path || !Number.isInteger(line) || line < 1 || !body) {
            result.omitted += 1;
            continue;
        }
        const fileLines = diff.get(path);
        if (!fileLines) {
            result.comments.push({
                path,
                subject_type: "file",
                body: `_Reported at line ${line}, which is not part of this diff._\n\n${body}`,
            });
            continue;
        }
        const valid = fileLines[side];
        if (valid.has(line)) {
            const payload = { path, line, side, body };
            const startLine = Number(comment.start_line);
            const startSide = comment.start_side === "LEFT" ? "LEFT" : side;
            // Ranges must start before the end line and stay inside the diff.
            if (Number.isInteger(startLine) &&
                startLine < line &&
                fileLines[startSide].has(startLine)) {
                payload.start_line = startLine;
                payload.start_side = startSide;
            }
            result.comments.push(payload);
            continue;
        }
        const snapped = nearest(valid, line) ?? nearest(fileLines[side === "LEFT" ? "RIGHT" : "LEFT"], line);
        if (snapped === undefined) {
            result.comments.push({
                path,
                subject_type: "file",
                body: `_Reported at line ${line}, which is not part of this diff._\n\n${body}`,
            });
            continue;
        }
        result.comments.push({
            path,
            line: snapped,
            side: valid.has(snapped) ? side : side === "LEFT" ? "RIGHT" : "LEFT",
            body: `_Reported at line ${line}; nearest reviewable line shown._\n\n${body}`,
        });
    }
    result.comments = result.comments.slice(0, 50);
    return result;
}
async function resolveThreads(github, core, owner, repo, pullNumber, entries) {
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
        const id = String(entry.id ?? "").trim();
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        unique.push({ ...entry, id });
    }
    let ok = 0;
    let failed = 0;
    if (unique.length === 0)
        return { ok, failed };
    const appSlug = process.env.M6D_APP_SLUG;
    if (!appSlug)
        throw new Error("GitHub App slug is unavailable.");
    const appLogin = (0, helpers_js_1.normalizeBotLogin)(appSlug);
    const currentThreads = new Map((await listThreads(github, owner, repo, pullNumber)).map((thread) => [
        thread.id,
        thread,
    ]));
    for (const entry of unique) {
        try {
            const thread = currentThreads.get(entry.id);
            if (!thread)
                throw new Error("Review thread does not belong to this pull request.");
            if ((0, helpers_js_1.normalizeBotLogin)(thread.comments.nodes[0]?.author?.login) !== appLogin) {
                throw new Error("Review thread was not created by this GitHub App.");
            }
            core.info(`Thread ${entry.id}: isResolved=${thread.isResolved}.`);
            if (!thread.isResolved) {
                const rootCommentId = thread.comments.nodes[0]?.databaseId;
                if (entry.reply && rootCommentId) {
                    await github.rest.pulls.createReplyForReviewComment({
                        owner,
                        repo,
                        pull_number: pullNumber,
                        comment_id: rootCommentId,
                        body: (0, helpers_js_1.truncate)(entry.reply, 2000),
                    });
                }
                await github.graphql("mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }", { threadId: entry.id });
            }
            ok += 1;
        }
        catch (error) {
            failed += 1;
            core.warning(`Could not resolve review thread ${entry.id}: ${(0, helpers_js_1.errorMessage)(error)}`);
        }
    }
    return { ok, failed };
}
// Word-overlap similarity between two finding titles, 0 to 1. Loose on purpose:
// the same dropped concern gets reworded slightly every round.
function similarTitles(left, right) {
    const words = (value) => new Set(value
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .split(" ")
        .filter((word) => word.length > 3));
    const a = words(left);
    const b = words(right);
    let shared = 0;
    for (const word of a)
        if (b.has(word))
            shared += 1;
    return shared / Math.max(1, Math.min(a.size, b.size));
}
// Keep re-reviews converging. A finding on code untouched since the last review
// is deferred unless it is HIGH or CRITICAL; a finding matching an earlier
// dropped title is deferred unless its code changed since. Deferred findings
// are appended to `dropped` so they stay visible without blocking.
function scopeComments(comments, incremental, precedent, dropped, core) {
    if (!incremental)
        return comments;
    const changed = parseDiffLines(incremental.files);
    const previous = incremental.previous_head.slice(0, 7);
    return comments.filter((comment) => {
        const lines = changed.get(normalizePath(comment.path));
        const fresh = Boolean(lines?.[comment.side === "LEFT" ? "LEFT" : "RIGHT"].has(Number(comment.line)));
        if (fresh)
            return true;
        const match = precedent.find((title) => similarTitles(title, comment.title) >= 0.6);
        const reason = match
            ? `Matches an earlier dropped item ("${(0, helpers_js_1.truncate)(match, 120)}") and its code has not changed since ${previous}.`
            : comment.severity === "HIGH" || comment.severity === "CRITICAL"
                ? undefined
                : `Outside the changes since the last review (${previous}); noted here rather than blocking this round.`;
        if (!reason)
            return true;
        core.info(`Deferred ${comment.severity} "${comment.title}" at ${comment.path}:${comment.line}: ${reason}`);
        dropped.push({ title: comment.title, reason });
        return false;
    });
}
// Merge the verifier's decisions with the retry pass (if it ran), then mark
// every open thread that still has no decision as OPEN. A NOT_APPLICABLE
// without the required explanation also stays OPEN rather than closing silently.
function threadDecisions(review, core) {
    const expected = fs.existsSync(OPEN_THREADS_FILE)
        ? JSON.parse(fs.readFileSync(OPEN_THREADS_FILE, "utf8"))
        : [];
    const retry = fs.existsSync(".codex/threads.json")
        ? (0, helpers_js_1.parseJson)(fs.readFileSync(".codex/threads.json", "utf8").trim(), "Codex thread retry output").threads
        : [];
    const byId = new Map();
    for (const entry of [...(review.threads ?? []), ...(retry ?? [])]) {
        if (entry?.thread_id && !byId.has(entry.thread_id)) {
            byId.set(entry.thread_id, entry);
        }
    }
    return expected.map((id) => {
        const entry = byId.get(id);
        if (!entry)
            return { thread_id: id, status: "OPEN", reply: null };
        if (entry.status === "NOT_APPLICABLE" && !entry.reply?.trim()) {
            core.warning(`Thread ${id}: NOT_APPLICABLE without a reply; leaving it open.`);
            return { thread_id: id, status: "OPEN", reply: null };
        }
        return entry;
    });
}
async function submit({ github, context, core, }) {
    const { owner, repo } = context.repo;
    const pullNumber = Number(process.env.M6D_PR_NUMBER);
    const review = (0, helpers_js_1.parseJson)(fs.readFileSync(".codex/review.json", "utf8").trim(), "Codex review output");
    if (review.review_completed !== true) {
        throw new Error(`Codex review was not completed: ${review.failure_reason || "unknown reason"}`);
    }
    const quality = Number(review.quality_score);
    if (!Number.isInteger(quality) || quality < 1 || quality > 10) {
        throw new Error(`Invalid quality_score from Codex: ${review.quality_score}`);
    }
    // The diff we validate positions against and the commit we pin the review to
    // must be the same one Codex reviewed. If a push landed meanwhile, the newer
    // run owns this PR and this result is stale.
    const reviewedSha = process.env.M6D_HEAD_SHA;
    const liveSha = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data.head.sha;
    if (reviewedSha && liveSha !== reviewedSha) {
        throw new Error(`PR head moved from ${reviewedSha.slice(0, 7)} to ${liveSha.slice(0, 7)} during the review; a newer run supersedes this one.`);
    }
    const dropped = Array.isArray(review.dropped) ? [...review.dropped] : [];
    // INFO never blocks: it stays in the review body and is never posted inline.
    const comments = scopeComments((Array.isArray(review.comments) ? review.comments : []).filter((comment) => comment.severity !== "INFO"), fs.existsSync(INCREMENTAL_FILE)
        ? JSON.parse(fs.readFileSync(INCREMENTAL_FILE, "utf8"))
        : undefined, fs.existsSync(PRECEDENT_FILE)
        ? JSON.parse(fs.readFileSync(PRECEDENT_FILE, "utf8"))
        : [], dropped, core);
    const threads = threadDecisions(review, core);
    const openThreads = threads.filter((entry) => entry.status === "OPEN");
    const files = comments.length
        ? await github.paginate(github.rest.pulls.listFiles, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
        })
        : [];
    const inline = inlineComments(comments, parseDiffLines(files));
    // Resolve before posting the verdict so a failed resolution can still
    // downgrade the review instead of leaving an approval with open threads.
    const resolved = await resolveThreads(github, core, owner, repo, pullNumber, threads
        .filter((entry) => entry.status !== "OPEN")
        .map((entry) => ({
        id: entry.thread_id,
        reply: entry.status === "NOT_APPLICABLE" ? entry.reply ?? undefined : undefined,
    })));
    const canApprove = review.event === "APPROVE" &&
        review.merge_decision === "MERGE" &&
        inline.comments.length === 0 &&
        openThreads.length === 0 &&
        resolved.failed === 0;
    const event = canApprove ? "APPROVE" : "REQUEST_CHANGES";
    const mergeDecision = canApprove ? "MERGE" : "DO_NOT_MERGE";
    let body = String(review.body ?? "").trim();
    if (!body)
        throw new Error("Codex review body is empty.");
    if (resolved.failed > 0) {
        body += `\n\nWorkflow note: ${resolved.failed} review thread(s) could not be resolved; see the run log.`;
    }
    if (openThreads.length > 0) {
        body += [
            "",
            "",
            `Open review threads still to address: ${openThreads.length}`,
            ...openThreads.map((entry) => `- ${entry.thread_id}`),
        ].join("\n");
    }
    if (dropped.length > 0) {
        body += [
            "",
            "",
            "<details>",
            `<summary>Considered and dropped (${dropped.length})</summary>`,
            "",
            ...dropped.map((entry) => `- **${(0, helpers_js_1.truncate)(entry.title, 200)}**: ${(0, helpers_js_1.truncate)(entry.reason, 500)}`),
            "",
            "</details>",
        ].join("\n");
    }
    if (inline.omitted > 0) {
        body += `\n\nWorkflow note: ${inline.omitted} inline comment(s) were omitted because they were missing path, line, or body.`;
    }
    // GitHub caps review bodies at 65536 characters; cut the assembled text.
    body = (0, helpers_js_1.truncate)(body, 60000);
    // Pin the review to the commit Codex actually reviewed. Without this GitHub
    // files it under the newest head, so a push during the run would attach the
    // verdict and line numbers to code the review never saw.
    const target = {
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: reviewedSha,
    };
    // The batched review endpoint only takes line comments. File-level comments
    // go through the single-comment endpoint, which is the one that accepts
    // subject_type, after the review exists so they attach to the same commit.
    const lineComments = inline.comments.filter((comment) => !comment.subject_type);
    const fileComments = inline.comments.filter((comment) => comment.subject_type);
    const created = await github.rest.pulls.createReview({
        ...target,
        event,
        body,
        comments: lineComments,
    });
    for (const comment of fileComments) {
        await github.rest.pulls.createReviewComment({ ...target, ...comment });
    }
    core.setOutput("review_event", event);
    core.setOutput("merge_decision", mergeDecision);
    core.setOutput("quality_score", String(quality));
    core.setOutput("inline_count", String(inline.comments.length));
    core.setOutput("resolved_thread_count", String(resolved.ok));
    core.setOutput("failed_thread_resolution_count", String(resolved.failed));
    core.setOutput("review_url", created.data.html_url ?? "");
}
async function finish({ github, context, core, }) {
    const { owner, repo } = context.repo;
    const pullNumber = Number(process.env.M6D_PR_NUMBER);
    const headSha = process.env.M6D_HEAD_SHA || "";
    // The status comment describes the current head only. A run that finished
    // late for an older commit must not overwrite what the newer run wrote.
    const current = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data;
    if (headSha && current.head.sha !== headSha) {
        core.info(`Head moved from ${headSha.slice(0, 7)} to ${current.head.sha.slice(0, 7)}; leaving the status comment to the newer run.`);
        return;
    }
    const failed = process.env.M6D_FAILED_THREAD_COUNT || "0";
    const completed = process.env.M6D_CODEX_OUTCOME === "success" &&
        process.env.M6D_REVIEW_OUTCOME === "success";
    const decision = process.env.M6D_REVIEW_EVENT === "REQUEST_CHANGES"
        ? "Requested changes"
        : process.env.M6D_REVIEW_EVENT === "APPROVE"
            ? "Approved"
            : "No review submitted";
    const failedDetails = Number(failed) > 0
        ? [
            `Previous thread resolve failures: **${failed}**`,
            "",
            "Check that the review GitHub App is installed with issues and pull-request write access.",
            "",
        ]
        : [];
    const details = completed
        ? [
            `Decision: **${decision}**`,
            "",
            `Merge decision: **${process.env.M6D_MERGE_DECISION || "unknown"}**`,
            "",
            `Quality score: **${process.env.M6D_QUALITY_SCORE
                ? `${process.env.M6D_QUALITY_SCORE}/10`
                : "unknown"}**`,
            "",
            `Inline comments posted: **${process.env.M6D_INLINE_COUNT || "0"}**`,
            "",
            `Previous threads resolved: **${process.env.M6D_RESOLVED_THREAD_COUNT || "0"}**`,
            "",
            ...failedDetails,
            `Review: ${process.env.M6D_REVIEW_URL
                ? `[open review](${process.env.M6D_REVIEW_URL})`
                : "submitted"}`,
        ]
        : [
            "Codex review did not complete successfully.",
            "",
            "Check this workflow run's logs for details.",
        ];
    const body = [
        MARKER,
        "## Codex Review",
        "",
        `Commit: \`${headSha.slice(0, 7) || "unknown"}\``,
        "",
        ...details,
        "",
        "This comment is updated on each push.",
    ].join("\n");
    await upsertStatus(github, owner, repo, pullNumber, body);
}
