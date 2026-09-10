# M6D Review

A composite GitHub Action for Codex pull-request reviews, trusted `@review` commands, and replies to review threads created by the review bot.

Finder, verifier, thread-retry, and reply instructions live in `src/prompts/finder.md`, `src/prompts/verify.md`, `src/prompts/threads.md`, and `src/prompts/reply.md`.

The action has three modes because each mode is triggered by a different GitHub event. Consumer repositories keep three small workflow files while the review implementation lives here.

## Full review

Create `.github/workflows/review.yml`:

```yaml
name: Review

on:
  pull_request:
    branches: [develop]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR number to review
        required: true
        type: string

permissions: {}

concurrency:
  group: codex-review-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.pull_request.base.ref == 'develop' &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: self-hosted
    timeout-minutes: 60
    steps:
      - uses: boring91/m6d-review-action@main
        with:
          mode: review
          review-level: thorough
          base-branch: develop
          app-id: ${{ secrets.REVIEW_APP_ID }}
          app-private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

Every review is a finder stage followed by a verifier stage. `review-level: standard` (the default) runs one finder pass covering correctness, security, minimality, and taste. `review-level: thorough` runs those four as separate finder passes in parallel, each in its own Codex session. In both cases a verifier pass then checks every candidate against the checked-out code, drops what it cannot prove, and writes the final review. Dropped candidates are listed in a collapsed section of the review body. A defect pattern that recurs across the diff is reported once with every location listed.

Re-reviews are incremental. After the first round, the action diffs the last bot-reviewed commit against the new head and only that changed code is in scope for new `MEDIUM` and `LOW` findings; `HIGH` and `CRITICAL` may still be raised anywhere. Titles from every earlier "Considered and dropped" list are precedent (except duplicates merged into a confirmed finding), and a finding matching one is not re-raised unless its code changed since. Findings deferred by either rule are appended to the dropped list so they stay visible without adding a round. A force push or a compare over 300 files falls back to full scope. A thorough review of a large PR can take 40 minutes or more, so keep the job timeout at 60. `INFO` findings appear in the body only and never block; everything `LOW` and above is posted inline and requests changes. Reviews do not require projects to have test coverage.

Every open review-bot thread must receive an explicit decision: `FIXED` or `NOT_APPLICABLE` resolves it (the latter with a posted reply), `OPEN` leaves it and blocks approval. The open thread IDs are baked into the verifier's output schema so it cannot skip one. If it does anyway, one retry classifies just the missed threads; anything still undecided after that is treated as `OPEN`. Threads are never resolved by omission. Inline comments carry the finding title, so a later round can tell it is re-raising the same finding. A re-raised finding is written as the invariant the code must satisfy rather than the next counter-example. A `MEDIUM` or `LOW` finding already raised under the same title in two earlier rounds is conceded: it moves to the dropped list with the invariant, and its open threads are resolved with that invariant as the reply, so a review cannot loop on one finding. `HIGH` and `CRITICAL` findings are never conceded.

## Review command

Create `.github/workflows/review-command.yml`:

```yaml
name: Review Command

on:
  issue_comment:
    types: [created]

permissions: {}

concurrency:
  group: codex-review-command-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  dispatch:
    if: >-
      github.event.issue.pull_request &&
      github.event.issue.state == 'open' &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.comment.body, '@review') &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - uses: boring91/m6d-review-action@main
        with:
          mode: command
          app-id: ${{ secrets.REVIEW_APP_ID }}
          app-private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

## Review replies

Create `.github/workflows/review-reply.yml`:

```yaml
name: Review Reply

on:
  pull_request_review_comment:
    types: [created]

permissions: {}

concurrency:
  group: codex-reply-${{ github.event.comment.id }}
  cancel-in-progress: true

jobs:
  reply:
    if: >-
      github.event.pull_request.state == 'open' &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.base.ref == 'develop' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.comment.user.type != 'Bot' &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
      github.event.comment.in_reply_to_id
    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - uses: boring91/m6d-review-action@main
        with:
          mode: reply
          base-branch: develop
          app-id: ${{ secrets.REVIEW_APP_ID }}
          app-private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

`@review` and the final review after all threads resolve dispatch `review.yml` with only `pr_number`, so they run at whatever `review-level` that workflow sets.

The full-review workflow must remain named `review.yml` because command and reply modes dispatch it. If another filename is required, pass the same `review-workflow` input to the command and reply modes.

## Requirements

- A self-hosted Linux runner with Codex CLI, Git, Bash, and `base64` available.
- Codex CLI must already be authenticated on the runner.
- A GitHub App installed on the consumer repository with Contents, Issues, Pull requests, and Actions write permissions.
- Repository secrets named `REVIEW_APP_ID` and `REVIEW_APP_PRIVATE_KEY`, or equivalent values passed to the action inputs.

Contents write permission is required because GitHub gates review-thread resolution on repository write access, even when the token already has Pull requests write permission.

The action rejects drafts, forked pull requests, closed pull requests, and pull requests targeting a branch other than `base-branch`. Only owners, members, and collaborators can trigger `@review` commands or review-reply evaluations. A command comment must consist of exactly `@review`; mentions inside longer text are ignored. Finders, thread retries, and replies use `gpt-5.6-sol` at `high` reasoning effort; the verifier runs at `medium`, which kept every `HIGH` and `MEDIUM` finding in testing at about half the wall time. Codex runs with `danger-full-access` and an approval policy of `never`.

Use `@main` while developing. Pin production consumers to `@v1` or an exact commit SHA after verification.

## Verification

Install dependencies, compile the TypeScript source, and run the behavioral tests:

```bash
npm ci
npm test
```

Compiled files in `dist/` are committed so consumers can run the action without installing dependencies.
