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
  commits: 1 / 100,
  feedback: 20,
  approvals: 5,
  // Issue resolutions sit below pullRequests (15) and feedback (17). A resolved
  // issue is a meaningful unit of delivered work, but it is a coarser signal and
  // is frequently closed by a pull request that is already being counted, so the
  // weight is deliberately lower to limit double counting.
  issueResolutions: 8,
};

/**
 * Calculate a user's score from their metrics.
 *
 * Uses real pullRequests when available, otherwise falls back to
 * predictedPullRequests (synthesized from commits-per-PR ratios).
 *
 * @param {{ loc?: number, filesTouched?: number, pullRequests?: number, predictedPullRequests?: number, commits?: number, feedback?: number, approvals?: number, issueResolutions?: number }} user
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
    (user.issueResolutions || 0) * WEIGHTS.issueResolutions;

  return score || 0;
}

module.exports = { WEIGHTS, calculateScore };
