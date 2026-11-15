# Authenticate Grok through an ACP wrapper

- Status: Accepted
- Date: 2026-11-15
- Decided by: Contributor under the Human's Grok-support assignment
- Source: Human request to add Grok to AlexTrott/paseo-slp-plugin
- Supersedes: none

## Context

Grok Build exposes `agent stdio` and documents authentication before session
creation. Paseo 0.15.2's generic ACP adapter does not perform that handshake.

## Decision

Add Grok as a grant-bearing ACP wrapper family. Complete only advertised
noninteractive authentication before releasing initialization/session traffic;
reuse existing ACP role delivery and preserve host model/permission messages.
This process invariant cannot be enforced by repository protocol or a harness.
Keep six-family managed history immutable and distinguish the current
standalone domain from managed journal ownership.

## Consequences

Credentials stay with the CLI/daemon environment. Failures stop session work.
No model catalog, permission bypass or live-host acceptance is implied. Revisit
the bridge when the minimum supported host supplies compatible authentication.
