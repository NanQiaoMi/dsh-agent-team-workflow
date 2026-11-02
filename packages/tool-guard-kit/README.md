# @local/dsh-tool-guard-kit

Reusable **per-agent native-tool sandbox** for DeepSeek Harness Cordis plugins.

DSH exposes `ctx.tools.guard(fn)` — a synchronous, monotonic denial hook that runs
after the `tools/pre-execute` waterfall and **before the tool body**. This kit
packages the three recurring pieces so a plugin does not re-implement them:

1. **tool classification**: which native tools can mutate (write/edit/bash/terminal + families);
2. **synchronous policy table**: `readOnly` / `allow` / `deny` keyed by a caller-resolved subject;
3. **registration + lifecycle**: one `ctx.tools.guard` owned by a `ctx.effect`, plus an audit ring.

Zero dependencies, pure ESM, total functions (never throws), fail-open by default.

## Install / import

This repo is consumed through local links (`@local/*`). Import it by relative
path from a sibling package:

```js
import {
  installToolSandbox,
  createTeamSubjectResolver,
} from '../../tool-guard-kit/index.js'
```

## Quick start (Agent Teams plugin)

```js
export function apply(ctx, config) {
  const settings = resolveSettings(config)          // { roles: {...} }
  const store = createStore({ ctx, settings })

  installToolSandbox(ctx, {
    policies: settings.roles,                        // { role: { readOnly?, allow?, deny? } }
    resolveSubject: createTeamSubjectResolver({
      ctx,
      stateFor: (exec) => {
        const m = ctx.agentTeams.tryMembership(exec.agent)
        return m ? store.cachedState(m.root) : null  // synchronous snapshot
      },
    }),
    failOpen: true,
    auditLimit: 64,
    label: 'my-plugin.toolSandbox()',
  })
}
```

```yaml
roles:
  observer:   { readOnly: true }                          # denies write/edit/bash/terminal_*
  docs-only:  { allow: [read, grep, glob, write, edit] }  # exhaustive allowlist
  auditor:    { deny: [bash, write] }                     # exact-name denylist
```

## Generic plugins (no Agent Teams)

```js
const registry = new Map([['session-a', { deny: ['bash'] }]])
installToolSandbox(ctx, {
  resolveSubject: (exec) => ({ key: exec.agent?.id, role: registry.has(exec.agent?.id) ? exec.agent.id : null }),
  resolvePolicy: (subject) => registry.get(subject.role) ?? null,   // dynamic policies
  failOpen: false,                                                 // strict deployments
})
```

## API

| Export | Purpose |
| --- | --- |
| `createToolSandbox(options)` | pure instance: `check(exec)`, `setPolicies`, `audit(limit)`, `stats`, `policies` |
| `installToolSandbox(ctx, options)` | registers the guard under `ctx.effect`, returns sandbox + `dispose()` |
| `normalizePolicies(raw)` | `Map<role, {readOnly, allow, deny}>` from objects/Maps; unknown fields ignored |
| `isMutatingTool(name, options?)` | write/edit/bash/terminal + `terminal_*` / `str_replace_*` families |
| `createTeamSubjectResolver({ctx, stateFor, roleFromState?})` | Agent Teams adapter; Lead/outsiders resolve to null |
| `roleFromTeamState(state, name)` | reference role resolution (roleAssignments → unique owned item role) |
| `DEFAULT_MUTATING_TOOLS`, `DEFAULT_MUTATING_PREFIXES` | classification defaults |

Options for `createToolSandbox` / `installToolSandbox`:

```ts
{
  policies?: object | Map                    // static table
  resolveSubject?: (exec) => { key, role } | null
  resolvePolicy?: (subject, exec) => policy | null   // overrides the table (sync)
  failOpen?: boolean                         // default true
  tools?: string[]; prefixes?: string[]      // classification overrides
  onDeny?: (entry) => void                   // observer only, exceptions swallowed
  auditLimit?: number                        // default 64, max 512
  now?: () => string                         // audit timestamps
  label?: string                             // ctx.effect label
}
```

## Semantics

- **Monotonic**: only one guard returns the first denial; nothing can force-allow.
- **Fail-open by default**: a thrown resolver/state getter, malformed `exec`, or an
  unknown role returns `undefined` (allow). Use `failOpen: false` for strict mode —
  it denies with a "could not resolve" reason.
- **Lead and non-members are never blocked** by the Agent Teams adapter.
- **Workflow-owned tools** (`team_flow_*`) should be skipped by the host plugin and
  enforced by the workflow itself (the reference plugin's adapter does this).
- **Boundary**: this is tool-call-level enforcement, not an OS sandbox. Allowed
  `bash`/`terminal_*` still run inside DSH session permission/sandbox policy.

## Test

```bash
NODE=~/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node
"$NODE" --test test/*.test.mjs
```

Covers classification, normalization, allow/deny/readOnly decisions, fail-open vs
fail-closed, dynamic policies, audit bounds, install/dispose, and the Teams adapter.
