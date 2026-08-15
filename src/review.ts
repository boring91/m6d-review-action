import * as fs from "node:fs";

import {
  errorMessage,
  normalizeBotLogin,
  parseJson,
  quote,
  readPrompt,
  truncate,
} from "./helpers.js";
import type { Core, GitHub, HandlerOptions, PullRequest } from "./types.js";

const MARKER = "<!-- codex-review-status -->";
const SEVERITY = {
  CRITICAL: "🔴 CRITICAL",
  HIGH: "🟠 HIGH",
  MEDIUM: "🟡 MEDIUM",
  LOW: "🔵 LOW",
  INFO: "🟢 INFO",
};

type Severity = keyof typeof SEVERITY;

type ReviewThreadComment = {
  author?: { login: string };
  body?: string;
  createdAt?: string;
  path?: string;
  line?: number;
  originalLine?: number;
};

type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  viewerCanResolve?: boolean;
  path?: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  diffSide?: string;
  comments: { nodes: ReviewThreadComment[] };
};

type ModelComment = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line: number | null;
  start_side: "RIGHT" | "LEFT" | null;
  severity: Severity;
  body: string;
};

type InlineComment = {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
};

type ReviewResult = {
  event: "APPROVE" | "REQUEST_CHANGES";
  merge_decision: "MERGE" | "DO_NOT_MERGE";
  quality_score: number;
  review_completed: boolean;
  failure_reason: string | null;
  body: string;
  comments: ModelComment[];
  resolved_thread_ids: string[];
};

export async function resolve({
  github,
  context,
  core,
}: HandlerOptions): Promise<void> {
  const { owner, repo } = context.repo;
  const pullRequest =
    context.payload.pull_request ??
    (
      await github.rest.pulls.get({
        owner,
        repo,
        pull_number: Number(process.env.M6D_PR_NUMBER),
      })
    ).data as PullRequest;
  const expectedRepo = `${owner}/${repo}`;
  const expectedBase = process.env.M6D_BASE_BRANCH;
  const problems = [];

  if (pullRequest.state !== "open")
    problems.push(`state is ${pullRequest.state}`);
  if (pullRequest.draft) problems.push("PR is a draft");
  if (pullRequest.base?.ref !== expectedBase) {
    problems.push(`base is ${pullRequest.base?.ref}, expected ${expectedBase}`);
  }
  if (pullRequest.head?.repo?.full_name !== expectedRepo) {
    problems.push(
      `head repo is ${pullRequest.head?.repo?.full_name}, expected ${expectedRepo}`,
    );
  }
  if (problems.length > 0) {
    core.setFailed(
      `Refusing to review PR #${pullRequest.number}: ${problems.join("; ")}.`,
    );
    return;
  }

  core.setOutput("number", String(pullRequest.number));
  core.setOutput("head_sha", pullRequest.head.sha);
  core.setOutput("base_ref", pullRequest.base.ref);
  core.setOutput("base_sha", pullRequest.base.sha);
  core.setOutput("title", pullRequest.title ?? "");
}

function reviewSchema(): Record<string, unknown> {
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
      "resolved_thread_ids",
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
          required: [
            "path",
            "line",
            "side",
            "start_line",
            "start_side",
            "severity",
            "body",
          ],
          properties: {
            path: { type: "string", minLength: 1 },
            line: { type: "integer", minimum: 1 },
            side: { type: "string", enum: ["RIGHT", "LEFT"] },
            start_line: { type: ["integer", "null"], minimum: 1 },
            start_side: {
              type: ["string", "null"],
              enum: ["RIGHT", "LEFT", null],
            },
            severity: { type: "string", enum: Object.keys(SEVERITY) },
            body: { type: "string", minLength: 1 },
          },
        },
      },
      resolved_thread_ids: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1 },
      },
    },
  };
}

function reviewPrompt(repository: string, thorough: boolean): string {
  const prompt = readPrompt("review.md").replace("{{repository}}", repository);
  return thorough
    ? `${prompt.trimEnd()}\n\n${readPrompt("review-thorough.md")}`
    : prompt;
}

async function listThreads(
  github: GitHub,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              isOutdated
              viewerCanResolve
              path
              line
              startLine
              originalLine
              originalStartLine
              diffSide
              comments(first: 20) {
                nodes {
                  author { login }
                  body
                  createdAt
                  path
                  line
                  originalLine
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
  const nodes: ReviewThread[] = [];
  let cursor: string | null = null;

  do {
    const result = await github.graphql(query, {
      owner,
      repo,
      number: pullNumber,
      cursor,
    });
    const threads = result.repository.pullRequest.reviewThreads as {
      nodes: ReviewThread[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    nodes.push(...threads.nodes);
    cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);

  return nodes;
}

async function upsertStatus(
  github: GitHub,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  const appSlug = process.env.M6D_APP_SLUG;
  if (!appSlug) throw new Error("GitHub App slug is unavailable.");

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const appLogin = normalizeBotLogin(appSlug);
  const existing = comments.find(
    (comment) =>
      comment.body?.includes(MARKER) &&
      (comment.performed_via_github_app?.slug === appSlug ||
        normalizeBotLogin(comment.user?.login) === appLogin),
  );

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

export async function prepare({
  github,
  context,
}: Pick<HandlerOptions, "github" | "context">): Promise<void> {
  const { owner, repo } = context.repo;
  const pullRequest =
    context.payload.pull_request ??
    (
      await github.rest.pulls.get({
        owner,
        repo,
        pull_number: Number(process.env.M6D_PR_NUMBER),
      })
    ).data as PullRequest;
  const pullNumber = pullRequest.number;

  await upsertStatus(
    github,
    owner,
    repo,
    pullNumber,
    [
      MARKER,
      "## Codex Review",
      "",
      `Codex is reviewing commit \`${(process.env.M6D_HEAD_SHA || "").slice(0, 7)}\`.`,
      "",
      "This comment is updated on each push.",
    ].join("\n"),
  );

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
    quote(pullRequest.body || "(no description)"),
    "",
    "## Prior Review Bodies",
    "",
  ];

  const bodies = reviews.filter((review) => review.body).slice(-20);
  if (bodies.length === 0) contextLines.push("No prior review bodies found.");
  for (const review of bodies) {
    contextLines.push(
      `### ${review.user.login} ${review.state} at ${review.submitted_at}`,
      "",
      quote(review.body),
      "",
    );
  }

  contextLines.push("", "## Prior Review Threads", "");
  if (threads.length === 0) contextLines.push("No prior review threads found.");
  for (const [index, thread] of threads.entries()) {
    const comments = thread.comments.nodes;
    const first = comments[0] ?? {};
    const file = thread.path ?? first.path ?? "unknown";
    const line =
      thread.line ??
      thread.originalLine ??
      first.line ??
      first.originalLine ??
      "unknown";

    contextLines.push(
      `### Thread ${index + 1}: ${thread.isResolved ? "resolved" : "unresolved"}, ${
        thread.isOutdated ? "outdated" : "current"
      }`,
      `Thread ID: ${thread.id}`,
      `File: ${file}:${line}`,
      `Side: ${thread.diffSide ?? "unknown"}`,
    );
    if (thread.startLine || thread.originalStartLine) {
      contextLines.push(
        `Range start: ${thread.startLine ?? thread.originalStartLine}`,
      );
    }
    for (const comment of comments) {
      contextLines.push(
        "",
        `Comment by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}`,
        "",
        quote(comment.body),
      );
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
    contextLines.push(
      `### ${comment.user.login} at ${comment.created_at}`,
      "",
      quote(comment.body),
      "",
    );
  }

  fs.mkdirSync(".codex", { recursive: true });
  fs.writeFileSync(
    ".codex/pr-context.md",
    `${contextLines.join("\n")}\n`,
    "utf8",
  );
  fs.writeFileSync(
    ".codex/review-schema.json",
    `${JSON.stringify(reviewSchema(), null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    ".codex/review-prompt.md",
    [
      reviewPrompt(
        `${owner}/${repo}`,
        process.env.M6D_REVIEW_LEVEL === "thorough",
      ),
      "",
      "Runtime review target:",
      `- PR title: ${process.env.M6D_PR_TITLE}`,
      `- Base ref: ${process.env.M6D_BASE_REF}`,
      `- Base SHA: ${process.env.M6D_BASE_SHA}`,
      `- Head SHA: ${process.env.M6D_HEAD_SHA}`,
      `- Compare with: git diff ${process.env.M6D_BASE_SHA}...${process.env.M6D_HEAD_SHA}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function normalizePath(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^[ab]\//, "");
}

function commentBody(comment: ModelComment): string {
  const key: Severity = SEVERITY[comment.severity]
    ? comment.severity
    : "MEDIUM";
  const label = SEVERITY[key];
  const body = truncate(comment.body, 4000);
  return body ? (body.startsWith(label) ? body : `${label}\n\n${body}`) : "";
}

function inlineComments(source: ModelComment[]): {
  comments: InlineComment[];
  omitted: number;
} {
  const result: { comments: InlineComment[]; omitted: number } = {
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

    const payload: InlineComment = { path, line, side, body };
    const startLine = Number(comment.start_line);
    const startSide = comment.start_side === "LEFT" ? "LEFT" : side;
    if (Number.isInteger(startLine) && startLine > 0 && startLine <= line) {
      payload.start_line = startLine;
      payload.start_side = startSide;
    }
    result.comments.push(payload);
  }

  result.comments = result.comments.slice(0, 50);
  return result;
}

async function resolveThreads(
  github: GitHub,
  core: Core,
  owner: string,
  repo: string,
  pullNumber: number,
  ids: string[],
): Promise<{ ok: number; failed: number }> {
  const unique = [
    ...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)),
  ].slice(0, 50);
  let ok = 0;
  let failed = 0;
  if (unique.length === 0) return { ok, failed };

  const appSlug = process.env.M6D_APP_SLUG;
  if (!appSlug) throw new Error("GitHub App slug is unavailable.");
  const appLogin = normalizeBotLogin(appSlug);

  const currentThreads = new Map(
    (await listThreads(github, owner, repo, pullNumber)).map((thread) => [
      thread.id,
      thread,
    ]),
  );

  for (const threadId of unique) {
    try {
      const thread = currentThreads.get(threadId);
      if (!thread)
        throw new Error("Review thread does not belong to this pull request.");
      if (
        normalizeBotLogin(thread.comments.nodes[0]?.author?.login) !== appLogin
      ) {
        throw new Error("Review thread was not created by this GitHub App.");
      }

      core.info(
        `Thread ${threadId}: isResolved=${thread.isResolved}, viewerCanResolve=${thread.viewerCanResolve}.`,
      );
      if (!thread.isResolved && !thread.viewerCanResolve) {
        throw new Error("Review thread cannot be resolved by this GitHub App.");
      }
      if (!thread.isResolved) {
        await github.graphql(
          "mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }",
          { threadId },
        );
      }
      ok += 1;
    } catch (error) {
      failed += 1;
      core.warning(
        `Could not resolve review thread ${threadId}: ${errorMessage(error)}`,
      );
    }
  }

  return { ok, failed };
}

export async function submit({
  github,
  context,
  core,
}: HandlerOptions): Promise<void> {
  const { owner, repo } = context.repo;
  const pullNumber = Number(process.env.M6D_PR_NUMBER);
  const review = parseJson<ReviewResult>(
    fs.readFileSync(".codex/review.json", "utf8").trim(),
    "Codex review output",
  );

  if (review.review_completed !== true) {
    throw new Error(
      `Codex review was not completed: ${review.failure_reason || "unknown reason"}`,
    );
  }
  const quality = Number(review.quality_score);
  if (!Number.isInteger(quality) || quality < 1 || quality > 10) {
    throw new Error(
      `Invalid quality_score from Codex: ${review.quality_score}`,
    );
  }

  const comments = Array.isArray(review.comments) ? review.comments : [];
  const resolvedIds = Array.isArray(review.resolved_thread_ids)
    ? review.resolved_thread_ids
    : [];
  const inline = inlineComments(comments);
  const canApprove =
    review.event === "APPROVE" &&
    review.merge_decision === "MERGE" &&
    inline.comments.length === 0;
  const event = canApprove ? "APPROVE" : "REQUEST_CHANGES";
  const mergeDecision = canApprove ? "MERGE" : "DO_NOT_MERGE";
  let body = truncate(review.body, 60000);

  if (!body) throw new Error("Codex review body is empty.");
  if (inline.omitted > 0) {
    body += `\n\nWorkflow note: ${inline.omitted} inline comment(s) were omitted because they were missing path, line, or body.`;
  }

  let created: { data: { html_url?: string } };
  let postedInline = inline.comments.length;
  try {
    created = await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event,
      body,
      comments: inline.comments,
    });
  } catch (error) {
    if (inline.comments.length === 0) throw error;
    core.warning(
      `Batched review submission failed; retrying inline comments individually: ${errorMessage(error)}`,
    );
    created = await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event,
      body,
    });

    let rejected = 0;
    for (const comment of inline.comments) {
      try {
        await github.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: process.env.M6D_HEAD_SHA,
          ...comment,
        });
      } catch (commentError) {
        rejected += 1;
        core.warning(
          `Dropped inline comment at ${comment.path}:${comment.line}: ${errorMessage(commentError)}`,
        );
      }
    }

    postedInline = inline.comments.length - rejected;
    if (rejected > 0) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: `Workflow note: GitHub rejected ${rejected} of ${inline.comments.length} inline comment position(s); the remaining ${postedInline} were posted individually.`,
      });
    }
  }

  const resolved = await resolveThreads(
    github,
    core,
    owner,
    repo,
    pullNumber,
    resolvedIds,
  );
  core.setOutput("review_event", event);
  core.setOutput("merge_decision", mergeDecision);
  core.setOutput("quality_score", String(quality));
  core.setOutput("inline_count", String(postedInline));
  core.setOutput("resolved_thread_count", String(resolved.ok));
  core.setOutput("failed_thread_resolution_count", String(resolved.failed));
  core.setOutput("review_url", created.data.html_url ?? "");
}

export async function finish({
  github,
  context,
}: Pick<HandlerOptions, "github" | "context">): Promise<void> {
  const { owner, repo } = context.repo;
  const pullNumber = Number(process.env.M6D_PR_NUMBER);
  const failed = process.env.M6D_FAILED_THREAD_COUNT || "0";
  const completed =
    process.env.M6D_CODEX_OUTCOME === "success" &&
    process.env.M6D_REVIEW_OUTCOME === "success";
  const decision =
    process.env.M6D_REVIEW_EVENT === "REQUEST_CHANGES"
      ? "Requested changes"
      : process.env.M6D_REVIEW_EVENT === "APPROVE"
        ? "Approved"
        : "No review submitted";
  const failedDetails =
    Number(failed) > 0
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
        `Quality score: **${
          process.env.M6D_QUALITY_SCORE
            ? `${process.env.M6D_QUALITY_SCORE}/10`
            : "unknown"
        }**`,
        "",
        `Inline comments posted: **${process.env.M6D_INLINE_COUNT || "0"}**`,
        "",
        `Previous threads resolved: **${process.env.M6D_RESOLVED_THREAD_COUNT || "0"}**`,
        "",
        ...failedDetails,
        `Review: ${
          process.env.M6D_REVIEW_URL
            ? `[open review](${process.env.M6D_REVIEW_URL})`
            : "submitted"
        }`,
      ]
    : [
        "Codex review did not complete successfully.",
        "",
        "Check this workflow run's logs for details.",
      ];
  const headSha = process.env.M6D_HEAD_SHA || "";
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
