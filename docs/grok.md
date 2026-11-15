# Grok support

Managed and standalone Grok use the host's generic `acp` adapter and the
package's `bin/grok-role.mjs` wrapper, running `grok agent stdio` over stdio.
The registry generates `slp-grok-supervisor`, `slp-grok-lead` and
`slp-grok-peer` with `extends: acp`. An explicit `binaries.grok` selects an
executable outside PATH. Serve, headless and any other argv are refused.

Generic ACP drops `config.systemPrompt`. Role bytes and the session-open
grant therefore belong to the launcher and wrapper. The shim keeps
`SLP_SESSION_OPEN_GRANT` for Grok until the wrapper consumes it. A
daemon-stamped session (`PASEO_AGENT_ID`) needs a nonempty grant from the
enabled `agent.session_open` hook before the ACP child starts. The wrapper
deletes the grant before spawn. Standalone ACP and a bare `--version` probe
do not need the grant. This adds no plugin setting: the protocol cannot stop
an ungranted subprocess, and the harness does not own the argv allow-list.

Executable selection requires Grok Build >=0.2.11, the catalog shape Paseo
records for `grok agent stdio`. The wrapper re-probes `--version` before ACP
spawn. Recognized output includes `grok 1.0.77 (hash) [stable]` and a leading
`v`. Malformed output and versions below the floor are refused. Model and
reasoning-effort discovery was observed on Grok 1.0.77 (`grok-4.7`,
`grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`, and `thought_level` efforts
`xhigh`/`high`/`medium`/`low`). Modes were not advertised. SLP does not
hardcode those ids or a model constraint: the host catalog supplies models
and thinking options. That observation is not fleet E2E, model compliance,
or proof that later builds keep the same catalog.

Grok supervision brief/handback/send mappings remain unverified. No install,
sign-in or config repair is attempted as a fallback.
