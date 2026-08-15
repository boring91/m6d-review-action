import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  isTrustedAssociation,
  normalizeBotLogin,
  parseJson,
  quote,
  readPrompt,
  truncate,
} from "./helpers.js";
import * as command from "./command.js";
import * as reply from "./reply.js";
import * as review from "./review.js";
import type { Context, Core, GitHub, PullRequest } from "./types.js";

type AnyRecord = Record<string, any>;

type TestCore = Core & {
  outputs: Record<string, unknown>;
  warnings: string[];
  failures: string[];
};

function createCore(): TestCore {
  const outputs: Record<string, unknown> = {};
  const warnings: string[] = [];
  const failures: string[] = [];
  return {
    outputs,
    warnings,
    failures,
    info(_message: string) {},
    notice(_message: string) {},
    setFailed(message: string) {
      failures.push(message);
    },
    setOutput(name: string, value: unknown) {
      outputs[name] = value;
    },
    warning(message: string) {
      warnings.push(message);
    },
  };
}

function pullRequest(): PullRequest {
  return {
    number: 42,
    title: "Test pull request",
    body: "",
    state: "open",
    draft: false,
    user: { login: "developer" },
    base: { ref: "main", sha: "base-sha" },
    head: {
      ref: "feature",
      sha: "head-sha",
      repo: { full_name: "acme/project" },
    },
  };
}

async function withEnvironment(
  values: Record<string, string>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function inTemporaryDirectory(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m6d-review-"));
  try {
    process.chdir(directory);
    await run(directory);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

test("helpers parse output and enforce trusted associations", () => {
  assert.deepEqual(parseJson('```json\n{"ok":true}\n```', "output"), {
    ok: true,
  });
  assert.equal(truncate("abcdef", 3), "abc\n...[truncated]");
  assert.equal(quote("one\ntwo"), "> one\n> two");
  assert.equal(isTrustedAssociation("MEMBER"), true);
  assert.equal(isTrustedAssociation("CONTRIBUTOR"), false);
  assert.equal(normalizeBotLogin("m6d-review"), "m6d-review[bot]");
  assert.equal(normalizeBotLogin("M6D-Review[BOT]"), "m6d-review[bot]");
});

test("packaged prompts load independently of the working directory", async () => {
  await inTemporaryDirectory(() => {
    assert.match(readPrompt("review.md"), /\{\{repository\}\}/);
    assert.match(readPrompt("review-thorough.md"), /spawn exactly four subagents/i);
    assert.match(readPrompt("review.md"), /do not require test coverage/i);
    assert.match(readPrompt("reply.md"), /\{\{repository\}\}/);
  });
});

test("review action pins GPT-5.6 Sol and caps thorough reviews at four agents", () => {
  const action = fs.readFileSync(path.join(__dirname, "../action.yml"), "utf8");
  assert.match(action, /--model gpt-5\.6-sol/);
  assert.match(action, /review_args=\(--ephemeral\)/);
  assert.match(action, /if \[\[ "\$M6D_REVIEW_LEVEL" == "thorough" \]\]; then\s+review_args=\(\s+-c/);
  assert.match(action, /codex exec --model gpt-5\.6-sol "\$\{review_args\[@\]\}"/);
  assert.match(action, /agents\.enabled=true/);
  assert.match(action, /agents\.max_concurrent_threads_per_session=4/);
  assert.match(action, /agents\.default_subagent_model="gpt-5\.6-sol"/);
});

test("thread handlers request repository write access", () => {
  const action = fs.readFileSync(path.join(__dirname, "../action.yml"), "utf8");
  assert.equal(action.match(/permission-contents: write/g)?.length, 2);
});

test("review commands dispatch standard and thorough levels", async () => {
  const dispatches: AnyRecord[] = [];
  const context: Context = {
    repo: { owner: "acme", repo: "project" },
    payload: {
      issue: { number: 42, state: "open", pull_request: {} },
      comment: {
        id: 8,
        body: "@review",
        user: { login: "maintainer", type: "User" },
        author_association: "MEMBER",
      },
      repository: { default_branch: "main" },
    },
  };
  const github = {
    rest: {
      actions: {
        createWorkflowDispatch: async (payload: AnyRecord) =>
          dispatches.push(payload),
      },
      reactions: { createForIssueComment: async () => {} },
    },
  } as unknown as GitHub;

  await command.dispatchReview({ github, context, core: createCore() });
  context.payload.comment!.body = "please @review thorough";
  await command.dispatchReview({ github, context, core: createCore() });

  assert.deepEqual(dispatches[0].inputs, { pr_number: "42" });
  assert.deepEqual(dispatches[1].inputs, {
    pr_number: "42",
    review_level: "thorough",
  });
});

test("reply validation rejects untrusted authors", async () => {
  const context: Context = {
    repo: { owner: "acme", repo: "project" },
    payload: {
      pull_request: pullRequest(),
      comment: {
        id: 8,
        user: { login: "contributor", type: "User" },
        author_association: "CONTRIBUTOR",
        in_reply_to_id: 7,
      },
    },
  };

  await withEnvironment({ M6D_BASE_BRANCH: "main" }, async () => {
    const untrusted = createCore();
    await reply.validate({ context, core: untrusted });
    assert.equal(untrusted.outputs.skip, "true");

    context.payload.comment!.author_association = "MEMBER";
    const trusted = createCore();
    await reply.validate({ context, core: trusted });
    assert.equal(trusted.outputs.skip, "false");
    assert.equal(trusted.outputs.head_sha, "head-sha");

    context.payload.pull_request!.state = "closed";
    const closed = createCore();
    await reply.validate({ context, core: closed });
    assert.equal(closed.outputs.skip, "true");
  });
});

test("status updates only the current GitHub App comment", async () => {
  const listComments = () => {};
  const listReviews = () => {};
  const updates: AnyRecord[] = [];
  const comments = [
    {
      id: 1,
      body: "<!-- codex-review-status -->",
      user: { login: "attacker" },
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 2,
      body: "<!-- codex-review-status -->",
      user: { login: "m6d-review[bot]" },
      performed_via_github_app: { slug: "m6d-review" },
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const github = {
    rest: {
      issues: {
        listComments,
        updateComment: async (payload: AnyRecord) => updates.push(payload),
        createComment: async () =>
          assert.fail("should update the existing app comment"),
      },
      pulls: { listReviews },
    },
    paginate: async (endpoint: unknown) =>
      endpoint === listReviews ? [] : comments,
    graphql: async () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  } as unknown as GitHub;
  const context: Context = {
    repo: { owner: "acme", repo: "project" },
    payload: { pull_request: pullRequest() },
  };

  await inTemporaryDirectory(async (directory) => {
    await withEnvironment(
      {
        M6D_APP_SLUG: "m6d-review",
        M6D_BASE_REF: "main",
        M6D_BASE_SHA: "base-sha",
        M6D_HEAD_SHA: "head-sha",
        M6D_PR_TITLE: "Test pull request",
        M6D_REVIEW_LEVEL: "standard",
      },
      () => review.prepare({ github, context }),
    );
    const prompt = fs.readFileSync(
      path.join(directory, ".codex/review-prompt.md"),
      "utf8",
    );
    assert.match(prompt, /pull request for acme\/project/);
    assert.doesNotMatch(prompt, /\{\{repository\}\}/);
    assert.doesNotMatch(prompt, /Thorough Review Workflow/);

    await withEnvironment(
      {
        M6D_APP_SLUG: "m6d-review",
        M6D_BASE_REF: "main",
        M6D_BASE_SHA: "base-sha",
        M6D_HEAD_SHA: "head-sha",
        M6D_PR_TITLE: "Test pull request",
        M6D_REVIEW_LEVEL: "thorough",
      },
      () => review.prepare({ github, context }),
    );
    const thoroughPrompt = fs.readFileSync(
      path.join(directory, ".codex/review-prompt.md"),
      "utf8",
    );
    assert.match(thoroughPrompt, /Thorough Review Workflow/);
    assert.match(thoroughPrompt, /Correctness and reliability/);
    assert.match(thoroughPrompt, /Security and trust boundaries/);
    assert.match(thoroughPrompt, /Minimality and reuse/);
    assert.match(thoroughPrompt, /Taste and consistency/);
  });

  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.map((update) => update.comment_id),
    [2, 2],
  );
});

test("review verdict fails closed and resolves only current PR threads", async () => {
  const core = createCore();
  const reviews: AnyRecord[] = [];
  const resolved: string[] = [];
  let blockedDecision: unknown;
  let blockedFailedThreads: unknown;
  let blockedResolvedThreads: unknown;
  const github = {
    rest: {
      issues: { createComment: async () => {} },
      pulls: {
        createReview: async (payload: AnyRecord) => {
          reviews.push(payload);
          return { data: { html_url: "https://example.test/review" } };
        },
        createReviewComment: async () => {},
      },
    },
    graphql: async (query: string, variables: AnyRecord) => {
      if (query.includes("reviewThreads(first:")) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "current-thread",
                    isResolved: false,
                    viewerCanResolve: true,
                    comments: {
                      nodes: [{ author: { login: "m6d-review" } }],
                    },
                  },
                  {
                    id: "human-thread",
                    isResolved: false,
                    viewerCanResolve: true,
                    comments: {
                      nodes: [{ author: { login: "human-reviewer" } }],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      if (query.includes("resolveReviewThread")) {
        resolved.push(variables.threadId);
        return { resolveReviewThread: { thread: { id: variables.threadId } } };
      }
      throw new Error("Unexpected GraphQL request.");
    },
  } as unknown as GitHub;
  const context: Context = {
    repo: { owner: "acme", repo: "project" },
    payload: {},
  };

  await inTemporaryDirectory(async (directory) => {
    fs.mkdirSync(path.join(directory, ".codex"));
    fs.writeFileSync(
      path.join(directory, ".codex/review.json"),
      JSON.stringify({
        event: "REQUEST_CHANGES",
        merge_decision: "MERGE",
        quality_score: 7,
        review_completed: true,
        failure_reason: null,
        body: "Review body",
        comments: [],
        resolved_thread_ids: [
          "current-thread",
          "human-thread",
          "foreign-thread",
        ],
      }),
    );
    await withEnvironment(
      {
        M6D_APP_SLUG: "m6d-review",
        M6D_HEAD_SHA: "head-sha",
        M6D_PR_NUMBER: "42",
      },
      () => review.submit({ github, context, core }),
    );
    blockedDecision = core.outputs.merge_decision;
    blockedFailedThreads = core.outputs.failed_thread_resolution_count;
    blockedResolvedThreads = core.outputs.resolved_thread_count;

    fs.writeFileSync(
      path.join(directory, ".codex/review.json"),
      JSON.stringify({
        event: "APPROVE",
        merge_decision: "MERGE",
        quality_score: 9,
        review_completed: true,
        failure_reason: null,
        body: "Approved",
        comments: [],
        resolved_thread_ids: [],
      }),
    );
    await withEnvironment(
      {
        M6D_APP_SLUG: "m6d-review",
        M6D_HEAD_SHA: "head-sha",
        M6D_PR_NUMBER: "42",
      },
      () => review.submit({ github, context, core }),
    );
  });

  assert.equal(reviews[0].event, "REQUEST_CHANGES");
  assert.equal(blockedDecision, "DO_NOT_MERGE");
  assert.equal(reviews[1].event, "APPROVE");
  assert.equal(core.outputs.merge_decision, "MERGE");
  assert.deepEqual(resolved, ["current-thread"]);
  assert.equal(blockedResolvedThreads, "1");
  assert.equal(blockedFailedThreads, "2");
  assert.match(core.warnings.join("\n"), /was not created by this GitHub App/);
  assert.match(
    core.warnings.join("\n"),
    /does not belong to this pull request/,
  );
});
