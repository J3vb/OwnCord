# Solid.js components

Phase B Step 6 lives here. This directory holds the incremental Solid.js
migration of the OwnCord client. Vanilla TypeScript components and Solid
components coexist throughout the migration; new UI work goes in this
directory, and existing leaf components are ported one PR at a time.

## Migration recipe

1. **Pick a leaf component.** Start with components that have no children of
   their own and read at most one or two stores. Avoid container components
   until every leaf inside them is Solid-native.
2. **Read state via the adapter.** Import `fromStore` or `fromStoreSlice` from
   `@lib/solidAdapter` and pass the existing custom store. Do **not** rewrite
   the store — Solid components and vanilla components share the same source
   of truth.
3. **Mount via `solidMount`.** Containers that aren't yet Solid-native should
   call `mountSolid(component, parentEl)` from `@lib/solidMount`. The returned
   handle has the same `{ destroy }` shape that the rest of the codebase uses.
4. **Test the pipeline.** New components get a `*.test.tsx` next to them
   using `@solidjs/testing-library`. The tests run under the existing Vitest
   configuration without any extra setup.
5. **Delete vanilla DOM code.** Once a component is fully migrated, remove
   the old factory function and update its callers to import from
   `@components/solid/...`.

## Allowed reactivity

- `createSignal`, `createMemo`, `createEffect`, `createResource`
- `Show`, `For`, `Switch`/`Match`, `Index`
- `onMount`, `onCleanup`

## Forbidden patterns

- Direct DOM manipulation inside Solid components — use Solid's bindings or a
  ref. The point of the migration is to delete manual DOM lifecycle code.
- Re-implementing existing stores in Solid's `createStore`. Wrap the existing
  custom store via `fromStore` instead.
- Touching framework-agnostic code (`lib/ws.ts`, `lib/dispatcher.ts`,
  `lib/livekitSession.ts`, `lib/api.ts`). These never need to know about Solid.

## Existing components

- `Badge.tsx` — presentational badge / pill (no store dependency)
- `ChannelListItem.tsx` — single channel row (subscribes to channels.store)

The plugin client bridge introduced by Phase C also adds a `PluginContainer`
component to this directory; see `Server/plugin/host_ui.go` for the host
side of that contract.
