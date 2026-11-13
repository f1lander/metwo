# Less slop: what is in mevo and what is next

From the web team's AI plan: codebase → style guide → static analysis → prose review → human
review, small PRs, security red-teaming, a shared MCP server, a wiki that keeps up.

## In mevo now

- **Small PRs.** Settings → Reviewable PRs: a target size the lane splits work around (follow-ups
  in its summary), a max that keeps a PR from being marked ready, a minimum Greptile score. All off
  by default. Size on cards and in the PR's Review Guide.
- **Style guide and lint.** The lane runs lint until it passes and never disables a rule; the
  review pass names the style-guide rule each finding breaks. A lint rule enforces this
  as well.
- **Verification.** Gates, local checks with related e2e, visual check in a browser, supervisor
  with proofs. Already the standard for every lane.
- **Prose review.** Greptile is tagged on every PR and its findings go back to the lane.
- **Security lens.** Added signing, transactions, approvals, auth, storage or raw HTML turn on a
  bug-bounty style read in the review pass.
- **Support fixes.** A label in `classifier.startLabels` plus autopilot: small tickets with it start
  by themselves.
- **Shared MCP.** `knowledge.mcp` names MCP servers the lanes have (the ENS Labs one); the brief
  sends the lane there for context and shared skills.
- **Knowledge note.** Every summary ends with what a teammate in another area should know.

## Next

- **Wiki updates.** After a merge, turn the Knowledge note into a proposed wiki edit through the
  shared MCP, reviewed by a person before it lands. Needs the MCP's write tools.
- **Security evals.** Run the security lens against the paid bug bounty reports (the diff that
  introduced each issue) and measure how many it catches. Needs access to the reports.
- **Shared skills back.** Offer mevo's PR description, regression and Greptile loop as shared
  skills on the MCP, for the team to review and own.
- **Stacked follow-ups.** Turn the lane's Follow-ups into Linear sub-issues with one click.
