# Architecture Decision Records (DECISIONS.md)

This file records key architectural choices and trade-offs across the repository so future sessions do not re-litigate settled constraints or reintroduce past pitfalls.

---

## ADR-001: Zero External Dependencies & Pure Node.js ESM

- **Decision**: Keep all three packages (`agent-team-workflow`, `dsh-git-graph`, `tool-guard-kit`) on pure Node.js ESM using only `node:*` built-in modules, with no `npm install` or transpilation step.
- **Rationale**: Plugins load directly as linked directories inside DeepSeek Harness (DSH). Avoiding external packages eliminates supply-chain drift, lockfile churn, and runtime install failures, and ensures tests run identically in local Node and GitHub Actions (`node 22` / `node 24`).
- **Trade-off**: Configuration validation lives in pure JS (`lib/config.js`) rather than Cordis `schemastery`, and `tools.integration.test.mjs` includes a zero-dependency JSON-Schema fallback when `@deepseek-ai/dsh-tools` is not present.

## ADR-002: Barrel Facade Pattern for Splitting Large `lib/*.js` Modules

- **Decision**: When breaking up oversized core modules (started with `lib/tools.js` → `lib/tools/*.js` in PR #15; planned for `lib/workflow.js` and `lib/dashboard.js`), keep `lib/<name>.js` as a thin barrel facade preserving every existing named export, and organize submodules as a strict DAG above a shared leaf module.
- **Rationale**: Over two dozen internal files and test suites import from `lib/workflow.js` and `lib/dashboard.js`. A thin facade prevents mass import churn and preserves external/test contracts while keeping each domain submodule focused and reviewable.
- **Trade-off**: Slightly more files under `lib/<name>/`, mitigated by strict acyclic imports and planned architecture guardrails.

## ADR-003: Worktree Safety Invariants (v2.1–v2.2)

- **Decision**: Enforce four layered git/worktree safety invariants in `worktree-manager.js` and `orchestrator.js`:
  1. **Wave 1+ Lazy Provisioning** (`lazyWorktreeProvision`): Only provision worktrees for unlocked items initially; provision downstream waves lazily from the latest `runBranch` after upstream merges.
  2. **In-Scope Auto-Commit on Report** (`autoCommitOnReport`): Safely commit uncommitted changes within `item.writeScopes` during `team_flow_report`, while rejecting out-of-scope edits instead of silently dropping work.
  3. **Conflict-Free Auto-Presync**: Before squash-merging an approved worktree, attempt `abortOnConflict: true` sync with latest `runBranch` so clean rebases never waste a model turn.
  4. **Post-Merge Integration Gate** (`integrationVerifyCommands`): Block `finalize` unless integration checks pass on `runBranch`.
- **Rationale**: Parallel agents previously suffered from stale Wave 1+ baselines, dropped uncommitted changes, unnecessary conflict wakeups, and "false green" finalizations when independent branches broke each other upon merge.

## ADR-004: Token & Latency Efficiency Invariants (v2.1–v2.3)

- **Decision**: Control prompt/schema bloat and reasoning cost through measurable gates:
  - `presetToolPruning` in `lib/tool-matrix.js` trims non-essential collaboration tools per preset (`fast-fix`, `feature`, `pr-review`) and re-adds them dynamically via `refreshMemberTools` if collaboration escalates.
  - `hostVerifyOnReport` records a tamper-resistant `hostVerified` SHA-bound snapshot so `light` reviews skip redundant slow test reruns.
  - Lead policy text is slimmed under 3.2 KB (`1,875 B` measured) with consecutive-failure circuit-breaker guidance.
  - `thinking-router.js` escalates reasoning on rework/stall recovery and downgrades non-blocking turns once `tokenBudgetPerRun` reaches 80%.
  - `bench/measure-payloads.mjs --check` enforces hard byte budgets in CI.
- **Rationale**: Tool schemas and policies are re-sent on every model turn; shrinking them yields multiplicative token and wall-clock savings across multi-agent runs.

## ADR-005: Keep `client.js` Single-File Under Webview Sandbox Contract

- **Decision**: Defer splitting `packages/agent-team-workflow/client.js` (5,595 lines) and `packages/dsh-git-graph/client.js` (2,000 lines) during the v2.4 backend modularization.
- **Rationale**: Both files execute inside the Host webview sandbox with a strict zero-external-require contract verified by `test/client.contract.test.mjs`. Splitting them cleanly would require introducing either a client bundler or a multi-file loader contract in DSH, which conflicts with ADR-001 unless specifically scoped as a separate UI milestone.
