/**
 * Property harness for row view-models (5.4a, reused by 5.4c/d).
 *
 * The signature of a model row is the model itself, so a row is only honest if
 * every model field changes what the row draws. `assertEveryFieldDraws` checks
 * that for one model type, plus that patching a drawn row to a model gives the
 * same DOM as drawing that model from scratch.
 */

import fc from "fast-check";
import { expect } from "vitest";

export type PlainModel = { readonly [k: string]: unknown };

export interface RowModelHarnessOptions<M extends PlainModel> {
  /** Apply `next` to a row drawn from another model, as `patch.apply` does. */
  readonly patch?: {
    readonly fields: readonly string[];
    readonly apply: (el: Element, next: M) => void;
  };
  /** Fields a handler bound at create time needs but the row does not draw,
   *  each with the reason; they are exempt from the "changes the DOM" check. */
  readonly bindingOnly?: Readonly<Record<string, string>>;
  /** Wait for async drawing (an avatar image swap) before the DOM is read. */
  readonly settle?: () => Promise<void>;
  /** Property runs. */
  readonly numRuns?: number;
}

/** Draw `model` into the document, let async drawing finish, return its HTML. */
async function html<M extends PlainModel>(
  create: (model: M) => Element,
  model: M,
  settle: (() => Promise<void>) | undefined,
): Promise<string> {
  const el = create(model);
  document.body.appendChild(el);
  await settle?.();
  const out = el.outerHTML;
  el.remove();
  return out;
}

/**
 * For every field of a random model that is not `bindingOnly`: change just that
 * field (`mutate` returns a different value for it) and assert the row's
 * `outerHTML` differs. With `patch`, also assert patch(create(a), b) renders
 * exactly like create(b) for b differing from a in patch fields only.
 */
export async function assertEveryFieldDraws<M extends PlainModel>(
  arb: fc.Arbitrary<M>,
  create: (model: M) => Element,
  mutate: (model: M, field: string) => M,
  opts: RowModelHarnessOptions<M> = {},
): Promise<void> {
  const { patch, bindingOnly = {}, settle, numRuns = 40 } = opts;
  await fc.assert(
    fc.asyncProperty(arb, async (base) => {
      const baseHtml = await html(create, base, settle);
      for (const field of Object.keys(base)) {
        if (field in bindingOnly) continue;
        const changed = mutate(base, field);
        expect(changed[field], `mutate must change ${field}`).not.toEqual(base[field]);
        expect(await html(create, changed, settle), `field ${field} is not drawn`).not.toBe(
          baseHtml,
        );
      }
      if (patch === undefined) return;
      for (const field of patch.fields) {
        const next = mutate(base, field);
        const el = create(base);
        document.body.appendChild(el);
        patch.apply(el, next);
        await settle?.();
        const patched = el.outerHTML;
        el.remove();
        expect(patched, `patching ${field} differs from drawing it`).toBe(
          await html(create, next, settle),
        );
      }
    }),
    { numRuns },
  );
}
