# Keep seven-family enforcement status within 64 KiB

- Status: Accepted
- Date: 2026-11-15
- Decided by: Contributor under the Human's Grok-support assignment
- Source: Seven-family regression measurement in tests/plugin-enforcement.test.mjs
- Supersedes: none

## Context

Adding Grok expands capability/gap inventory to 57/30 rows. The existing
worst-case status fixture exceeds the unchanged 65,536-byte limit with 16
bindings; even 14 rows exceed it. Thirteen rows fit, including the longest
family identifier. The prior power-of-two candidate set no longer fits.

## Decision

Set the membership projection cap to 13, the largest fitting whole-number cap.
Retain the 64 KiB budget, all capability/gap rows and the 16-repository scan.
The plugin owns wire-size bounds; repository protocol cannot enforce them.

## Consequences

The view omits oldest excess binding rows with its existing completeness
accounting. Stored memberships, authority and task capacity do not change.
The regression measures both 13 and 14 rows and passes the complete at-cap
fixture through the real emit guard; future inventory changes must remeasure.
