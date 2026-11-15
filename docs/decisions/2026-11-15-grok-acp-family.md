# Add Grok as an ACP role family

- Status: Accepted
- Date: 2026-11-15
- Decided by: Human
- Source: Human request to add Grok and its models
- Supersedes: none

## Context

Grok Build speaks ACP (`grok agent stdio`) and advertises a model catalog
plus standard `thought_level` reasoning. Generic ACP drops `config.systemPrompt`,
so a registered native adapter is the wrong shape and a hook gate cannot
deliver role bytes. Paseo already maps ACP models and thought levels.

## Decision

Add `grok` as a wrapper family extending `acp`, with `bin/grok-role.mjs`
and a `>=0.2.11` version floor. Models and thinking options come from the
host catalog. Freeze the six-family plugin history; new records use seven
families and twenty-one providers. Standalone generation gains Grok and
still excludes Antigravity. Historical receipts gain no Grok slots until a
collision-checked rebind. Role bytes and the session-open grant stay in the
launcher and wrapper. No new plugin setting.

## Consequences

No daemon install, no fleet E2E claim, and no supervision mapping. The
enforcement-status membership cap is 8, the largest power of two whose
worst-case view stays under 64 KiB after the new capability rows. Revisit
if Grok stops advertising ACP models or `thought_level`, or if a host starts
delivering `systemPrompt` on generic ACP.
