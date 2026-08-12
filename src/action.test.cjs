const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  isTrustedAssociation,
  parseJson,
  quote,
  readPrompt,
  truncate,
} = require("./helpers.cjs");
const reply = require("./reply.cjs");
const review = require("./review.cjs");

function createCore() {
  const outputs = {};
  const warnings = [];
  return {
    outputs,
    warnings,
    info() {},
    notice() {},
    setOutput(name, value) {
      outputs[name] = value;
    },
    warning(message) {
      warnings.push(message);
    },
  };
}

function pullRequest() {
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

async function withEnvironment(values, run) {
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

async function inTemporaryDirectory(run) {
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
});

test("packaged prompts load independently of the working directory", async () => {
  await inTemporaryDirectory(() => {
    assert.match(readPrompt("review.md"), /\{\{repository\}\}/);
    assert.match(readPrompt("reply.md"), /\{\{repository\}\}/);
  });
});

test("reply validation rejects untrusted authors", async () => {
  const context = {
    repo: { owner: "acme", repo: "project" },
    payload: {
      pull_request: pullRequest(),
      comment: {
        user: { type: "User" },
        author_association: "CONTRIBUTOR",
        in_reply_to_id: 7,
      },
    },
  };

  await withEnvironment({ M6D_BASE_BRANCH: "main" }, async () => {
    const untrusted = createCore();
    await reply.validate({ context, core: untrusted });
    assert.equal(untrusted.outputs.skip, "true");

    context.payload.comment.author_association = "MEMBER";
    const trusted = createCore();
    await reply.validate({ context, core: trusted });
    assert.equal(trusted.outputs.skip, "false");
    assert.equal(trusted.outputs.head_sha, "head-sha");

    context.payload.pull_request.state = "closed";
    const closed = createCore();
    await reply.validate({ context, core: closed });
    assert.equal(closed.outputs.skip, "true");
  });
});

test("status updates only the current GitHub App comment", async () => {
  const listComments = () => {};
  const listReviews = () => {};
  const updates = [];
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
        updateComment: async (payload) => updates.push(payload),
        createComment: async () =>
          assert.fail("should update the existing app comment"),
      },
      pulls: { listReviews },
    },
    paginate: async (endpoint) => (endpoint === listReviews ? [] : comments),
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
  };
  const context = {
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
      },
      () => review.prepare({ github, context }),
    );
    const prompt = fs.readFileSync(
      path.join(directory, ".codex/review-prompt.md"),
      "utf8",
    );
    assert.match(prompt, /pull request for acme\/project/);
    assert.doesNotMatch(prompt, /\{\{repository\}\}/);
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].comment_id, 2);
});

test("review verdict fails closed and resolves only current PR threads", async () => {
  const core = createCore();
  const reviews = [];
  const resolved = [];
  let blockedDecision;
  let blockedFailedThreads;
  let blockedResolvedThreads;
  const github = {
    rest: {
      issues: { createComment: async () => {} },
      pulls: {
        createReview: async (payload) => {
          reviews.push(payload);
          return { data: { html_url: "https://example.test/review" } };
        },
        createReviewComment: async () => {},
      },
    },
    graphql: async (query, variables) => {
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
                      nodes: [{ author: { login: "m6d-review[bot]" } }],
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
  };
  const context = { repo: { owner: "acme", repo: "project" } };

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
