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
async function validate({ context, core, }) {
    const pr = context.payload.pull_request;
    const comment = context.payload.comment;
    const expectedRepo = `${context.repo.owner}/${context.repo.repo}`;
    const expectedBase = process.env.M6D_BASE_BRANCH;
    const problems = [];
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
    const marker = `<!-- codex-reply:${triggerComment.id} -->`;
    const alreadyReplied = thread.some((comment) => (0, helpers_js_1.normalizeBotLogin)(comment.user.login) === botLogin &&
        (comment.body || "").includes(marker));
    if (alreadyReplied)
        return skip("Already replied to this comment; skipping.");
    const path = root.path ?? triggerComment.path ?? "unknown";
    const line = triggerComment.line ??
        triggerComment.original_line ??
        root.line ??
        root.original_line ??
        "unknown";
    const diffHunk = triggerComment.diff_hunk || root.diff_hunk || "";
    const lines = [
        "# Review Thread Reply Evaluation",
        "",
        `Repository: ${owner}/${repo}`,
        `Pull request: #${pullNumber} ${pr.title}`,
        `Head SHA (current checked-out code): ${pr.head.sha}`,
        `Base: ${pr.base.ref} (${pr.base.sha})`,
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
    fs.mkdirSync(".codex", { recursive: true });
    fs.writeFileSync(".codex/reply-context.md", `${lines.join("\n")}\n`, "utf8");
    fs.writeFileSync(".codex/reply-schema.json", `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    fs.writeFileSync(".codex/reply-prompt.md", [
        prompt,
        "",
        "Runtime target:",
        `- File: ${path}`,
        `- Line: ${line}`,
        `- Base SHA: ${pr.base.sha}`,
        `- Head SHA: ${pr.head.sha}`,
        `- Compare with: git diff ${pr.base.sha}...${pr.head.sha} -- ${path}`,
        "- Context file: .codex/reply-context.md",
        "",
    ].join("\n"), "utf8");
    core.setOutput("skip", "false");
    core.setOutput("root_comment_id", String(rootId));
    core.setOutput("bot_login", botLogin);
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
    const result = (0, helpers_js_1.parseJson)(fs.readFileSync(".codex/reply.json", "utf8").trim(), "Codex reply output");
    if (result.evaluation_completed !== true) {
        core.warning(`Evaluation not completed: ${result.reason || "unknown reason"}`);
        return;
    }
    const assessment = result.assessment;
    const agreed = assessment === "RESOLVED";
    const text = String(result.reply_markdown || "").trim();
    const reply = text ||
        (agreed ? "Agreed — this looks addressed. Resolving this thread." : "");
    if ((result.should_respond === true || agreed) && reply) {
        await github.rest.pulls.createReplyForReviewComment({
            owner,
            repo,
            pull_number: pullNumber,
            comment_id: rootId,
            body: `<!-- codex-reply:${triggerId} -->\n${reply}`,
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
    const query = `
    query($owner: String!, $repo: String!, $num: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $num) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes { databaseId author { login } }
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
    const target = threads.find((thread) => thread.comments.nodes[0]?.databaseId === rootId);
    if (!target) {
        core.warning(`Could not locate review thread for comment ${rootId}; skipping resolve.`);
        return;
    }
    if (!target.isResolved) {
        await github.graphql("mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }", { threadId: target.id });
        core.info(`Resolved thread ${target.id}.`);
    }
    if (!botLogin) {
        core.warning("Bot identity unknown; skipping the final-review check.");
        return;
    }
    const remaining = threads.filter((thread) => thread.id !== target.id &&
        !thread.isResolved &&
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
