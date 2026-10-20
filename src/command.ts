import { errorMessage, isTrustedAssociation, startReview } from "./helpers.js";
import type { HandlerOptions } from "./types.js";

export async function handleCommand({
  github,
  context,
  core,
}: HandlerOptions): Promise<void> {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue;
  const comment = context.payload.comment;
  const body = comment?.body || "";

  if (!issue?.pull_request || issue.state !== "open" || !comment) {
    core.notice("Comment is not on an open pull request; skipping.");
    return;
  }
  if (comment.user?.type === "Bot") {
    core.notice("Bot comments cannot request reviews; skipping.");
    return;
  }
  if (!isTrustedAssociation(comment.author_association)) {
    core.notice("Comment author does not have write access; skipping.");
    return;
  }
  // The whole comment must be the command, so prose that merely mentions
  // @review does not trigger a review.
  if (body.trim().toLowerCase() !== "@review") {
    core.notice("Comment is not exactly @review; skipping.");
    return;
  }

  const prNumber = issue.number;
  try {
    await github.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: "eyes",
    });
  } catch (error) {
    core.warning(`Could not react to the command comment: ${errorMessage(error)}`);
  }

  core.info(`@review from ${comment.user.login}; starting a review of PR #${prNumber}.`);
  await startReview({ github, context, core }, prNumber);
}
