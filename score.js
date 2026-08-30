/**
 * score.js — Shared scoring weights for repo-hero.
 *
 * This is the single source of truth for how user scores are calculated.
 * Used by gather-and-rank.js, results-reindexer.js, and results-enrich.js.
 */

const WEIGHTS = {
  loc: 1 / 10000,
  filesTouched: 1 / 10000,
  pullRequests: 15,
  predictedPullRequests: 15,
  commits: 1 / 150,
  feedback: 20,
  approvals: 5,
  // Issue resolutions sit below pullRequests (15) and feedback (17). A resolved
  // issue is a meaningful unit of delivered work, but it is a coarser signal and
  // is frequently closed by a pull request that is already being counted, so the
  // weight is deliberately lower to limit double counting.
  issueResolutions: 8,
};

/**
 * Churn is repo-hero's first "negative" metric -- it estimates the
 * review/rework cost of a pull request rather than crediting output. Its
 * sub-metrics (churnOpenDurationDays, churnFeedbackReviews,
 * churnNonBotComments) are gathered only from PRs eligible for churn (see
 * gather-and-rank.js: merged, 1+ review, 1+ approval) and are not surfaced
 * individually anywhere -- only the composite (calculateChurn()) is used,
 * and only to subtract from the overall score in calculateScore().
 */
const CHURN_WEIGHTS = {
  openDurationDays: 1, // per 24h a churn-eligible PR was open
  feedbackReviews: 3, // per review requesting changes / leaving feedback
  nonBotComments: 0.5, // per non-bot conversation comment not tied to a review
};

/**
 * Calculate a user's composite churn score from their churn sub-metrics.
 *
 * @param {{ churnOpenDurationDays?: number, churnFeedbackReviews?: number, churnNonBotComments?: number }} user
 * @returns {number}
 */
function calculateChurn(user) {
  const churn =
    (user.churnOpenDurationDays || 0) * CHURN_WEIGHTS.openDurationDays +
    (user.churnFeedbackReviews || 0) * CHURN_WEIGHTS.feedbackReviews +
    (user.churnNonBotComments || 0) * CHURN_WEIGHTS.nonBotComments;

  return churn || 0;
}

/**
 * Calculate a user's score from their metrics.
 *
 * Uses real pullRequests when available, otherwise falls back to
 * predictedPullRequests (synthesized from commits-per-PR ratios). The
 * composite churn score (see calculateChurn()) is subtracted from the total.
 *
 * @param {{ loc?: number, filesTouched?: number, pullRequests?: number, predictedPullRequests?: number, commits?: number, feedback?: number, approvals?: number, issueResolutions?: number, churnOpenDurationDays?: number, churnFeedbackReviews?: number, churnNonBotComments?: number }} user
 * @returns {number}
 */
function calculateScore(user) {
  const prs = user.pullRequests || 0;
  const predictedPrs = user.predictedPullRequests || 0;
  const effectivePrs = prs > 0 ? prs : predictedPrs;

  const score =
    (user.loc || 0) * WEIGHTS.loc +
    (user.filesTouched || 0) * WEIGHTS.filesTouched +
    effectivePrs * WEIGHTS.pullRequests +
    (user.commits || 0) * WEIGHTS.commits +
    (user.feedback || 0) * WEIGHTS.feedback +
    (user.approvals || 0) * WEIGHTS.approvals +
    (user.issueResolutions || 0) * WEIGHTS.issueResolutions -
    calculateChurn(user);

  // Clamp at 0 -- churn can offset earned credit down to nothing, but should
  // never push a user's score negative (several call sites, e.g. the
  // dashboard's "active users" filter, treat score > 0 as the active signal).
  return Math.max(0, score) || 0;
}

module.exports = { WEIGHTS, CHURN_WEIGHTS, calculateScore, calculateChurn };
