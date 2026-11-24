# AGENTS.md — Repository Guide & Engineering Guardrails

This repository is a zero-dependency Node.js (ESM) monorepo hosting DeepSeek Harness (DSH) Cordis plugins for multi-agent workflow orchestration, Git graph visualization, and native-tool sandboxing.

---

## 1. Monorepo Layout & Module Map

```text
.
├── .github/workflows/ci.yml        # CI matrix (Node 22 & 24, ubuntu-latest)
├── docs/
│   ├── DECISIONS.md                # Architecture Decision Records (ADRs)
│   └── 42-reliability-and-efficiency-v2.1-plan.md  # v2.1–v2.4 roadmap & delivery log
└── packages/
    ├── agent-team-workflow/        # Core multi-agent workflow plugin (@local/dsh-agent-team-workflow)
    │   ├── index.js                # Cordis plugin entrypoint, lifecycle, tool/prompt/sandbox wiring
    │   ├── client.js               # Live dashboard webview bundle (must obey zero-require sandbox)
    │   ├── cordis.patch.yml        # Default deployment patch overrides
    │   ├── bench/
    │   │   └── measure-payloads.mjs # Prompt/tool payload size budget gate (--check)
    │   ├── bin/                    # CLI helpers (agent-team-dev.mjs, scan-devkit.mjs)
    │   ├── lib/
    │   │   ├── config.js           # Settings resolution, presets, reversible feature switches
    │   │   ├── store.js            # Per-team atomic JSON blackboard (<cwd>/.agentteam/) + locking
    │   │   ├── workflow.js         # Thin barrel facade aggregating lib/workflow/*.js
    │   │   ├── workflow/           # Domain workflow submodules (constants, plan, review, collaboration, status-and-gates)
    │   │   ├── orchestrator.js     # Event-driven dispatcher, stall watchdog, auto-finalize
    │   │   ├── worktree-manager.js # Lazy Wave 1+ worktrees, auto-commit, auto-presync, integration verify
    │   │   ├── protocol.js         # Role policies, briefs, stall nudges, report rendering
    │   │   ├── tool-matrix.js      # Role/preset-scoped dynamic tool pruning
    │   │   ├── tools.js            # Thin barrel facade aggregating lib/tools/*.js
    │   │   ├── tools/              # Domain tool submodules (shared, plan-and-gate, execution-and-review, git-tools, collab-tools, devkit-tools)
    │   │   ├── thinking-router.js  # Adaptive reasoning effort & 80% token-budget downgrade
    │   │   ├── review-policy.js    # Risk classification & review depth/rubric routing
    │   │   ├── telemetry.js        # Token usage & reliability attribution metrics
    │   │   ├── dashboard.js        # Read-only snapshot builder for the live board
    │   │   ├── dashboard-route.js  # Authenticated Connection route for dashboard state
    │   │   ├── member-route.js     # Authenticated Connection route for member transcript/view
    │   │   ├── git.js              # Git CLI wrappers & porcelain parsing
    │   │   ├── devkit.js           # Project devkit scanning & test command discovery
    │   │   ├── scope-guard.js      # Runtime write-scope enforcement
    │   │   ├── tool-guard.js       # Team role subject resolver for tool-guard-kit
    │   │   ├── hooks.js            # Hook helpers
    │   │   └── transcript.js       # Session log summarizer
    │   └── test/                   # 23 Node test suites (*.test.mjs)
    ├── dsh-git-graph/              # Git commit DAG & branch visualizer (@local/dsh-git-graph)
    │   ├── index.js                # Cordis plugin entrypoint & git_graph_* tools
    │   ├── client.js               # Webview UI bundle (zero-require sandbox)
    │   ├── lib/git-engine.js       # Porcelain v2 parser, DAG layout, snapshot/commit inspection
    │   └── test/                   # 3 Node test suites (*.test.mjs)
    └── tool-guard-kit/             # Reusable per-agent tool sandbox (@local/dsh-tool-guard-kit)
        ├── index.js                # Policy-driven ctx.tools.guard wrapper + audit ring buffer
        └── test/                   # 1 Node test suite (kit.test.mjs)
```

---

## 2. Core Engineering Invariants (Do Not Violate)

1. **Zero External Runtime Dependencies**:
   - All packages use pure Node.js ESM (`"type": "module"`, Node `>= 22` in CI) with `node:*` built-ins only. Never add third-party `dependencies` or build steps unless explicitly approved.
2. **Webview `client.js` Sandbox Contract**:
   - Both `packages/agent-team-workflow/client.js` and `packages/dsh-git-graph/client.js` run inside the Host webview sandbox and must not contain external `require(...)` or Node-only imports. Always verify via `test/client.contract.test.mjs`.
3. **Barrel Facade Pattern for Large Modules**:
   - When splitting large `lib/*.js` files (as done for `lib/tools.js` → `lib/tools/*.js`), preserve the top-level `lib/<module>.js` file as a thin barrel facade re-exporting the exact public API so existing callers and tests remain 100% compatible.
   - Keep submodule dependencies strictly acyclic (layered downwards toward a `shared` / `constants` leaf).
4. **Reversible Feature Switches & State Compatibility**:
   - All workflow/orchestration features must be gated behind explicit switches in `packages/agent-team-workflow/lib/config.js` with safe defaults, and must remain backward-compatible with existing `.agentteam/teams/<id>/state.json` records.
5. **No Host-Path Coupling in Tests**:
   - All tests must pass in plain Node / Ubuntu GitHub Actions without requiring `/Applications/DSH Desktop.app` or local-only binaries.

---

## 3. Local Verification Commands (Run All Before Pushing)

All 4 gates run in `.github/workflows/ci.yml` on Node 22 & Node 24 and must pass locally before pushing:

```bash
cd packages/tool-guard-kit && node --test test/*.test.mjs
cd packages/dsh-git-graph && node --test test/*.test.mjs
cd packages/agent-team-workflow && node bench/measure-payloads.mjs --check
cd packages/agent-team-workflow && node --test test/*.test.mjs
```

---

## 4. Git & PR Workflow Rules

- **Never commit or push directly to `main`.** Always branch off up-to-date `origin/main` using `<type>/<scope>-<short-desc>`.
- Follow **Conventional Commits** (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `chore`).
- Check `git status` and `git diff --staged` before committing; never commit secrets, `.env`, logs, or scratch artifacts.
- Open a structured PR, watch `gh pr checks --watch` until all CI checks are green, and wait for explicit user approval before Squash Merging.
- Whenever architecture, module boundaries, or test/bench commands change, update `AGENTS.md` and `docs/DECISIONS.md` in the same PR.
