# M6D Review

A composite GitHub Action for Codex pull-request reviews, trusted `@review` commands, and replies to review threads created by the review bot.

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
    timeout-minutes: 45
    steps:
      - uses: boring91/m6d-review-action@main
        with:
          mode: review
          base-branch: develop
          app-id: ${{ secrets.REVIEW_APP_ID }}
          app-private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
```

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

The full-review workflow must remain named `review.yml` because command and reply modes dispatch it. If another filename is required, pass the same `review-workflow` input to the command and reply modes.

## Requirements

- A self-hosted Linux runner with Codex CLI, Git, Bash, and `base64` available.
- Codex CLI must already be authenticated on the runner.
- A GitHub App installed on the consumer repository with Contents read permission and Issues, Pull requests, and Actions write permissions.
- Repository secrets named `REVIEW_APP_ID` and `REVIEW_APP_PRIVATE_KEY`, or equivalent values passed to the action inputs.

The action rejects drafts, forked pull requests, closed pull requests, and pull requests targeting a branch other than `base-branch`. Only owners, members, and collaborators can trigger `@review` commands or review-reply evaluations. Codex runs with a read-only sandbox.

Use `@main` while developing. Pin production consumers to `@v1` or an exact commit SHA after verification.

## Verification

Run the dependency-free behavioral tests:

```bash
node --test
```
