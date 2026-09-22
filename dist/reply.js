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
exports.validate = validate;
exports.prepare = prepare;
exports.post = post;
const fs = __importStar(require("node:fs"));
const helpers_js_1 = require("./helpers.js");
async function validate({ github, context, core, }) {
    const comment = context.payload.comment;
    const expectedRepo = `${context.repo.owner}/${context.repo.repo}`;
    const expectedBase = process.env.M6D_BASE_BRANCH;
    const problems = [];
    // The event payload is a snapshot from when the comment was written. Pushes
    // that landed since then would otherwise be evaluated against a stale head.
    const number = context.payload.pull_request?.number;
    const pr = number
        ? (await github.rest.pulls.get({
            ...context.repo,
            pull_number: number,
        })).data
        : undefined;
    if (pr?.state !== "open")
        problems.push(`state is ${pr?.state}`);
    if (pr?.draft)
        problems.push("PR is a draft");
    if (pr?.base?.ref !== expectedBase) {
        problems.push(`base is ${pr?.base?.ref}, expected ${expectedBase}`);
    }
    if (pr?.head?.repo?.full_name !== expectedRepo) {
        problems.push(`head repo is ${pr?.head?.repo?.full_name}, expected ${expectedRepo}`);
    }
    if (comment?.user?.type === "Bot")
        problems.push("comment author is a bot");
    if (!(0, helpers_js_1.isTrustedAssociation)(comment?.author_association)) {
        problems.push(`comment author association is ${comment?.author_association ?? "unknown"}`);
    }
    if (!comment?.in_reply_to_id)
        problems.push("comment is not a reply");
    if (problems.length > 0) {
        core.notice(`Skipping review reply: ${problems.join("; ")}.`);
        core.setOutput("skip", "true");
        return;
    }
    if (!pr)
        return;
    core.setOutput("skip", "false");
    core.setOutput("head_sha", pr.head.sha);
    core.setOutput("base_ref", pr.base.ref);
    core.setOutput("base_sha", pr.base.sha);
}
async function prepare({ github, context, core, }) {
    const { owner, repo } = context.repo;
    const pr = context.payload.pull_request;
    const triggerComment = context.payload.comment;
    if (!pr || !triggerComment) {
        throw new Error("Pull request and trigger comment are required.");
    }
    const pullNumber = pr.number;
    let botLogin = "";
    try {
        const viewer = await github.graphql("{ viewer { login } }");
        botLogin = (0, helpers_js_1.normalizeBotLogin)(viewer.viewer.login);
    }
    catch (error) {
        core.warning(`Could not determine bot identity: ${(0, helpers_js_1.errorMessage)(error)}`);
    }
    const skip = (reason) => {
        core.notice(reason);
        core.setOutput("skip", "true");
    };
    const rootId = triggerComment.in_reply_to_id;
    if (!rootId)
        return skip("Comment is not a reply; skipping.");
    const allComments = await github.paginate(github.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
    });
    const root = allComments.find((comment) => comment.id === rootId);
    if (!root)
        return skip("Thread root comment not found; skipping.");
    if (!botLogin)
        return skip("Could not determine the review bot identity; skipping.");
    if ((0, helpers_js_1.normalizeBotLogin)(root.user.login) !== botLogin) {
        return skip(`Thread started by ${root.user.login}, not ${botLogin}; skipping.`);
    }
    const thread = allComments
        .filter((comment) => comment.id === rootId || comment.in_reply_to_id === rootId)
        .sort((left, right) => new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime());
    // A marker only means the reply text was posted. Resolution and the final
    // dispatch may still be pending from a failed earlier run, so keep going and
    // let `post` skip just the duplicate reply.
    const marker = `<!-- codex-reply:${triggerComment.id} -->`;
    const alreadyReplied = thread.some((comment) => (0, helpers_js_1.normalizeBotLogin)(comment.user.login) === botLogin &&
        (comment.body || "").includes(marker));
    if (alreadyReplied) {
        core.info("Reply already posted on an earlier run; re-evaluating without reposting.");
    }
    core.setOutput("already_replied", alreadyReplied ? "true" : "false");
    core.setOutput("root_comment_id", String(rootId));
    core.setOutput("bot_login", botLogin);
    // A waiver never reaches Codex: the model's verdict cannot be argued down,
    // only overridden on record by a role the consumer trusts to accept risk.
    const waive = String(triggerComment.body ?? "").trim().match(helpers_js_1.WAIVE_COMMAND);
    if (waive) {
        // One line: the review body records it as `- **title**: reason` later.
        const reason = waive[1].replace(/\s+/g, " ").trim();
        const roles = (process.env.M6D_WAIVE_ROLES || "OWNER")
            .split(",")
            .map((role) => role.trim().toUpperCase());
        if (!reason)
            return skip("Waiver without a reason; skipping. Use `@review waive <reason>`.");
        if (!roles.includes(String(triggerComment.author_association))) {
            return skip(`Waiver from ${triggerComment.author_association ?? "unknown"} ignored; allowed roles: ${roles.join(", ")}.`);
        }
        core.info(`Waiver by ${triggerComment.user.login}: ${reason}`);
        core.setOutput("skip", "false");
        core.setOutput("waiver", reason);
        return;
    }
    const path = root.path ?? triggerComment.path ?? "unknown";
    const line = triggerComment.line ??
        triggerComment.original_line ??
        root.line ??
        root.original_line ??
        "unknown";
    const diffHunk = triggerComment.diff_hunk || root.diff_hunk || "";
    // SHAs come from the refreshed PR in `validate`, not the event snapshot.
    const headSha = process.env.M6D_HEAD_SHA;
    const baseSha = process.env.M6D_BASE_SHA;
    const lines = [
        "# Review Thread Reply Evaluation",
        "",
        `Repository: ${owner}/${repo}`,
        `Pull request: #${pullNumber} ${pr.title}`,
        `Head SHA (current checked-out code): ${headSha}`,
        `Base: ${pr.base.ref} (${baseSha})`,
        `File: ${path}`,
        `Line: ${line}`,
        "",
        "## Code location (diff hunk from the original comment)",
        "",
        "```diff",
        (0, helpers_js_1.truncate)(diffHunk, 3000),
        "```",
        "",
        "## Conversation thread (oldest first)",
        "",
    ];
    for (const comment of thread) {
        const who = (0, helpers_js_1.normalizeBotLogin)(comment.user.login) === botLogin
            ? `${botLogin} (you, the reviewer)`
            : comment.user.login;
        lines.push(`### ${who} at ${comment.created_at}`, "", (0, helpers_js_1.quote)(comment.body, 4000), "");
    }
    lines.push("## The reply you must evaluate", "", `Author: ${triggerComment.user.login}`, "", (0, helpers_js_1.quote)(triggerComment.body, 4000), "");
    const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: [
            "evaluation_completed",
            "should_respond",
            "assessment",
            "reply_markdown",
            "reason",
        ],
        properties: {
            evaluation_completed: { type: "boolean" },
            should_respond: { type: "boolean" },
            assessment: {
                type: "string",
                enum: ["RESOLVED", "STILL_OPEN", "NEEDS_CLARIFICATION", "ACKNOWLEDGED"],
            },
            reply_markdown: { type: "string" },
            reason: { type: ["string", "null"] },
        },
    };
    const prompt = (0, helpers_js_1.readPrompt)("reply.md").replace("{{repository}}", `${owner}/${repo}`);
    // The checkout is untrusted PR content; start from an empty .codex.
    fs.rmSync(".codex", { recursive: true, force: true });
    fs.mkdirSync(".codex", { recursive: true });
    fs.writeFileSync(".codex/reply-context.md", `${lines.join("\n")}\n`, "utf8");
    fs.writeFileSync(".codex/reply-schema.json", `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    fs.writeFileSync(".codex/reply-prompt.md", [
        prompt,
        "",
        "Runtime target:",
        `- File: ${path}`,
        `- Line: ${line}`,
        `- Base SHA: ${baseSha}`,
        `- Head SHA: ${headSha}`,
        `- Full PR diff: git diff ${baseSha}...${headSha}`,
        `- File diff: git diff ${baseSha}...${headSha} -- ${path}`,
        "- Context file: .codex/reply-context.md",
        "",
    ].join("\n"), "utf8");
    core.setOutput("skip", "false");
    core.setOutput("waiver", "");
}
async function post({ github, context, core, }) {
    const { owner, repo } = context.repo;
    const pr = context.payload.pull_request;
    const triggerComment = context.payload.comment;
    if (!pr || !triggerComment) {
        throw new Error("Pull request and trigger comment are required.");
    }
    const pullNumber = pr.number;
    const rootId = Number(process.env.M6D_ROOT_COMMENT_ID);
    const botLogin = (0, helpers_js_1.normalizeBotLogin)(process.env.M6D_BOT_LOGIN);
    const triggerId = triggerComment.id;
    const waiver = process.env.M6D_WAIVER || "";
    const result = waiver
        ? {
            evaluation_completed: true,
            should_respond: true,
            assessment: "RESOLVED",
            reply_markdown: `${helpers_js_1.WAIVED} @${triggerComment.user.login}: ${waiver}`,
            reason: null,
        }
        : (0, helpers_js_1.parseJson)(fs.readFileSync(".codex/reply.json", "utf8").trim(), "Codex reply output");
    if (result.evaluation_completed !== true) {
        throw new Error(`Codex could not evaluate the reply: ${result.reason || "unknown reason"}`);
    }
    const assessment = result.assessment;
    const agreed = assessment === "RESOLVED";
    // Codex text is untrusted: only this run may stamp a reply as a waiver.
    const text = String(result.reply_markdown || "").replaceAll(helpers_js_1.WAIVED_MARKER, "").trim();
    const reply = text || (agreed ? "Agreed, this looks addressed. Resolving this thread." : "");
    if (process.env.M6D_ALREADY_REPLIED === "true") {
        core.info("Reply already posted on an earlier run; not reposting.");
    }
    else if ((result.should_respond === true || agreed) && reply) {
        await github.rest.pulls.createReplyForReviewComment({
            owner,
            repo,
            pull_number: pullNumber,
            comment_id: rootId,
            body: `<!-- codex-reply:${triggerId} -->\n${waiver ? `${helpers_js_1.WAIVED_MARKER}\n` : ""}${reply}`,
        });
        core.info(`Posted reply (assessment=${assessment}).`);
    }
    else {
        core.notice(`No reply posted (assessment=${assessment}, should_respond=${result.should_respond}).`);
    }
    if (!agreed) {
        core.notice(`Assessment ${assessment}; thread left open.`);
        return;
    }
    const listThreads = async () => {
        const query = `
      query($owner: String!, $repo: String!, $num: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $num) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                id
                isResolved
                comments(first: 1) {
                  nodes { databaseId author { login } body }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`;
        const threads = [];
        let cursor = null;
        do {
            const result = await github.graphql(query, {
                owner,
                repo,
                num: pullNumber,
                cursor,
            });
            const connection = result.repository.pullRequest.reviewThreads;
            threads.push(...connection.nodes);
            cursor = connection.pageInfo.hasNextPage
                ? connection.pageInfo.endCursor
                : null;
        } while (cursor);
        return threads;
    };
    const threads = await listThreads();
    const target = threads.find((thread) => thread.comments.nodes[0]?.databaseId === rootId);
    if (!target) {
        core.warning(`Could not locate review thread for comment ${rootId}; skipping resolve.`);
        return;
    }
    // A waiver covers the finding, not one thread: a re-raised finding owns one
    // bot thread per round, so every open sibling under the same title closes too.
    const title = waiver ? (0, helpers_js_1.raisedTitle)(target.comments.nodes[0]?.body) : undefined;
    const closing = threads.filter((thread) => !thread.isResolved &&
        (thread.id === target.id ||
            (title !== undefined &&
                (0, helpers_js_1.normalizeBotLogin)(thread.comments.nodes[0]?.author?.login) === botLogin &&
                (0, helpers_js_1.raisedTitle)(thread.comments.nodes[0]?.body) === title)));
    for (const thread of closing) {
        await github.graphql("mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }", { threadId: thread.id });
        core.info(`Resolved thread ${thread.id}.`);
    }
    if (!botLogin) {
        core.warning("Bot identity unknown; skipping the final-review check.");
        return;
    }
    // Re-fetch after resolving. Concurrent reply runs each resolve their own
    // thread, so a snapshot taken before the mutation would let every run see
    // another thread still open and nobody would dispatch the final review.
    const remaining = (await listThreads()).filter((thread) => !thread.isResolved &&
        (0, helpers_js_1.normalizeBotLogin)(thread.comments.nodes[0]?.author?.login) === botLogin);
    core.info(`${remaining.length} unresolved ${botLogin} thread(s) remain.`);
    if (remaining.length > 0)
        return;
    core.info("No unresolved review threads remain; dispatching a final review.");
    const defaultBranch = context.payload.repository?.default_branch;
    if (!defaultBranch)
        throw new Error("Repository default branch is unavailable.");
    await github.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: process.env.M6D_REVIEW_WORKFLOW,
        ref: defaultBranch,
        inputs: { pr_number: String(pullNumber) },
    });
}
