"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchReview = dispatchReview;
const helpers_js_1 = require("./helpers.js");
async function dispatchReview({ github, context, core, }) {
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
    if (!(0, helpers_js_1.isTrustedAssociation)(comment.author_association)) {
        core.notice("Comment author does not have write access; skipping.");
        return;
    }
    if (!/(^|\s)@review\b/i.test(body)) {
        core.notice("Comment does not contain a standalone @review command; skipping.");
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
    }
    catch (error) {
        core.warning(`Could not react to the command comment: ${(0, helpers_js_1.errorMessage)(error)}`);
    }
    core.info(`@review from ${comment.user.login}; dispatching review for PR #${prNumber}.`);
    const defaultBranch = context.payload.repository?.default_branch;
    if (!defaultBranch)
        throw new Error("Repository default branch is unavailable.");
    await github.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: process.env.M6D_REVIEW_WORKFLOW || "review.yml",
        ref: defaultBranch,
        inputs: { pr_number: String(prNumber) },
    });
}
