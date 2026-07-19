# Client Architecture (moved)

This document previously described the client architecture, including the
planned SolidJS migration. That migration was **abandoned** (see CHANGELOG)
and the beachhead code has been removed from the tree — the client is vanilla
TypeScript with hand-rolled reactive stores and imperative DOM components.

The current, maintained client architecture document is:

**[docs/architecture/client.md](architecture/client.md)**

See also [docs/architecture/README.md](architecture/README.md) for the full
blueprint set and its maintenance rule, and decision D6 in
[docs/plans/audit-2026-07-19-decisions.md](plans/audit-2026-07-19-decisions.md)
for the removal rationale.
