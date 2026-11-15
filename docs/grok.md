# Grok support

SLP supports the official **Grok Build CLI** as the `grok` family for Supervisor,
Lead and Peer seats. Both managed and standalone installations generate
`slp-grok-supervisor`, `slp-grok-lead` and `slp-grok-peer`, using Paseo's generic
`acp` adapter. No xAI HTTP client or model catalog is embedded in SLP.

## Setup

1. Install the official CLI using the [Grok Build instructions](https://docs.x.ai/build).
   On the daemon host, check that `grok --version` works.
2. Run `grok login` as the daemon's account, or provide `XAI_API_KEY` in the
   daemon process environment. Keep credentials out of routing files, command
   arguments and plugin settings. SLP does not start an interactive login.
3. Update/activate SLP. The executable resolver discovers `grok` on the daemon's
   PATH; Maintenance's `binaries.grok` override can select an absolute executable.
   An unavailable CLI leaves the generated providers disabled.
4. Choose **Grok** in **SLP → Profiles** or add a Grok option in **Peer pool**.
   Select an explicit model from the host-discovered catalog and save. Existing
   sessions retain their runtime; the saved choice applies to new launches.

Models, modes, thinking options and features come from the host/CLI catalog.
SLP preserves selected values, including model IDs containing slashes. It does
not guess a model or add a permission bypass. Unsupported selections remain
the host/provider's validation responsibility.

## ACP and authentication

The installed wrapper starts `grok --no-auto-update agent stdio`. The
[official scripting guide](https://docs.x.ai/build/cli/headless-scripting)
documents ACP over stdin/stdout and recommends disabling automatic updates in
automation. A bare `--version` probe retains the CLI's output and exit status;
interactive and print-mode commands are not session transports for this wrapper.

Paseo's [generic ACP adapter at 0.15.2](https://github.com/getpaseo/paseo/blob/v0.15.2/packages/server/src/server/agent/providers/acp-agent.ts)
initializes and creates sessions without calling `authenticate`. Grok's documented
ACP sequence authenticates first. The Grok bridge therefore holds the initialize
response and any pipelined session requests until that handshake succeeds:

- Choose advertised `xai.api_key` when a nonempty `XAI_API_KEY` is available;
  otherwise choose advertised `cached_token`.
- Send `authenticate` with `_meta.headless: true`, using a private request ID.
  The key itself stays in the subprocess environment, not the ACP frame.
- Consume the private response before releasing the original initialize result.
  A CLI advertising no authentication methods passes through unchanged.
- Reject unsupported or failed authentication with setup guidance. No browser
  login or alternate credential source is tried. Initialization/authentication
  has a 30-second deadline; failed or cancelled children get a finite shutdown
  grace before forced termination.

Authentication errors do not echo the CLI's response payload or credentials.
MCP declarations, model/mode changes, permission messages and other non-prompt
ACP frames retain their original bytes.

## Role and session behavior

The shared ACP transform prepends the role core, recovery pointer and current
managed language to every `session/prompt`. First prompts and prompts following
`session/load`, `session/resume` or `session/fork` also get entry helpers and
the measured policy carrier. Generic ACP does not deliver `config.systemPrompt`;
role delivery belongs to the wrapper.

Managed launchers verify the frozen manifest and installed runtime. A session
with `PASEO_AGENT_ID` needs a live `SLP_SESSION_OPEN_GRANT` from the enabled
session-open hook before Grok starts. The grant is consumed and removed before
the child runs, including version probes. Catalog probes without an agent ID
and standalone installs do not need a managed grant.

Live provider inventory must explicitly establish `extends: acp`. Where SDK
snapshots omit transport, desk selection reads the exact provider's live config
around a fresh snapshot. An alias name alone never establishes transport.

These authentication and launch invariants belong at the process boundary:
repository instructions cannot authenticate a subprocess or prevent ungranted
startup. They add no role authority, workflow, onboarding gate or new setting.

## Compatibility and evidence limits

Managed history retains the exact four-, five- and six-family vocabularies and
their hashes; new records use seven families and 21 provider slots. Older
receipts do not acquire Grok ownership. Rebinding checks collisions, and
deactivation/recovery preserves foreign Grok entries. Standalone installs have
six families (Grok included, Antigravity excluded) and their own exact domain.

The additional capability rows also reduce the enforcement status view's binding
projection from 16 to 13 rows to retain its 64 KiB worst-case response budget.
Older rows omitted from that view are reported in completeness; durable
memberships and the repository scan limit are unchanged.

Local tests exercise installed wrappers, fake ACP authentication, role bytes,
grant enforcement, catalog/config plumbing and historical restoration. They
do not establish live Grok account access, model compliance, MCP child delivery
or end-to-end Paseo acceptance. Communication-supervision timeline mappings
remain explicitly unverified for Grok. No real daemon or shared configuration
is changed by those tests.
