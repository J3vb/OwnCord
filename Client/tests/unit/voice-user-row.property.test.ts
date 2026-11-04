/**
 * Property tests for the voice participant row view (voiceRow.view.ts).
 *
 * `reconcileModels` derives a row's signature from its model, so the model is
 * only honest if every field changes the DOM the view draws, and a row patched
 * in place equals one drawn fresh:
 *  - changing any one model field (or any part of `audio` and `verify`)
 *    changes the row's outerHTML
 *  - patchVoiceUserRow(drawVoiceUserRow(a), b) renders exactly like
 *    drawVoiceUserRow(b)
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  assertEveryFieldDraws,
  dataUriAvatarFetchMock,
  mutateAvatarField,
  settleAvatar as settle,
} from "../helpers/rowModelProperty";

// The avatar image is behind the session token; stub the authenticated fetch.
vi.mock("../../src/features/messaging/content/attachments", (importOriginal) =>
  dataUriAvatarFetchMock(importOriginal),
);

import {
  VOICE_USER_PATCH_FIELDS,
  drawVoiceUserRow,
  patchVoiceUserRow,
  type VoiceAudioModel,
  type VoiceUserRowModel,
  type VoiceVerifyModel,
} from "../../src/features/channels/voiceRow.view";
import { createAvatarElement } from "../../src/features/profiles/avatar";

const draw = (model: VoiceUserRowModel): HTMLElement =>
  drawVoiceUserRow(model, createAvatarElement);

const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);

const STATUSES = ["verified", "changed", "unverified", "mismatch", "unknown"] as const;
const SHIELDS = ["shield-check", "shield-alert", "shield", "shield-question"] as const;
const COLORS = ["var(--green, #23a559)", "var(--yellow, #f0b232)", "var(--red, #f23f43)"];

const audio: fc.Arbitrary<VoiceAudioModel> = fc.record({
  icon: fc.constantFrom("mic-off" as const, "headphones-off" as const),
  server: fc.boolean(),
  title: fc.option(text, { nil: null }),
});

const verify: fc.Arbitrary<VoiceVerifyModel> = fc.record({
  cls: fc.constantFrom(...STATUSES),
  icon: fc.constantFrom(...SHIELDS),
  color: fc.constantFrom(...COLORS),
  title: text,
});

const rowModel: fc.Arbitrary<VoiceUserRowModel> = fc
  .record({
    userId: fc.integer({ min: 1, max: 100000 }),
    name: text,
    avatarName: text,
    avatarColor: fc.constantFrom("#5865f2", "#57f287", "#fee75c"),
    speaking: fc.boolean(),
    camera: fc.boolean(),
    live: fc.boolean(),
    audio: fc.option(audio, { nil: null }),
    localMuted: fc.boolean(),
    ownFingerprintTitle: fc.option(text, { nil: null }),
    verify: fc.option(verify, { nil: null }),
    draggable: fc.boolean(),
    self: fc.boolean(),
  })
  // A loaded picture hides the letter and its colour, so the base has none
  // and the mutation of avatarUrl adds one.
  .map((r) => ({ ...r, avatarUrl: null }));

function other<T>(choices: readonly T[], current: T): T {
  return choices.find((c) => c !== current)!;
}

function mutateRow(model: VoiceUserRowModel, field: string): VoiceUserRowModel {
  const avatar = mutateAvatarField(model, field);
  if (avatar !== undefined) return avatar;
  switch (field) {
    case "userId":
      return { ...model, userId: model.userId + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "speaking":
      return { ...model, speaking: !model.speaking };
    case "camera":
      return { ...model, camera: !model.camera };
    case "live":
      return { ...model, live: !model.live };
    case "audio":
      return {
        ...model,
        audio: model.audio === null ? { icon: "mic-off", server: false, title: null } : null,
      };
    case "localMuted":
      return { ...model, localMuted: !model.localMuted };
    case "ownFingerprintTitle":
      return { ...model, ownFingerprintTitle: model.ownFingerprintTitle === null ? "fp" : null };
    case "verify":
      return {
        ...model,
        verify:
          model.verify === null
            ? { cls: "verified", icon: "shield-check", color: COLORS[0]!, title: "t" }
            : null,
      };
    case "draggable":
      return { ...model, draggable: !model.draggable };
    case "self":
      return { ...model, self: !model.self };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("voice user row view", () => {
  it("every model field changes the row's DOM", async () => {
    await assertEveryFieldDraws(rowModel, draw, mutateRow, {
      patch: { fields: VOICE_USER_PATCH_FIELDS, apply: patchVoiceUserRow },
      bindingOnly: {
        self: "decides which handlers bind (volume menu, Shift+F10, drag); its drawn effects are localMuted, ownFingerprintTitle and draggable",
      },
      settle,
    });
  });

  it("every part of the verify badge is drawn", () => {
    fc.assert(
      fc.property(rowModel, verify, fc.constantFrom("cls", "icon", "color", "title"), (m, v, f) => {
        const base = { ...m, verify: v };
        const changed: VoiceVerifyModel =
          f === "cls"
            ? { ...v, cls: other(STATUSES, v.cls) }
            : f === "icon"
              ? { ...v, icon: other(SHIELDS, v.icon) }
              : f === "color"
                ? { ...v, color: other(COLORS, v.color) }
                : { ...v, title: `${v.title}x` };
        expect(draw({ ...base, verify: changed }).outerHTML).not.toBe(draw(base).outerHTML);
      }),
    );
  });

  it("every part of the audio icon is drawn", () => {
    fc.assert(
      fc.property(rowModel, audio, fc.constantFrom("icon", "server", "title"), (m, a, f) => {
        const base = { ...m, audio: a };
        const changed: VoiceAudioModel =
          f === "icon"
            ? { ...a, icon: a.icon === "mic-off" ? "headphones-off" : "mic-off" }
            : f === "server"
              ? { ...a, server: !a.server }
              : { ...a, title: a.title === null ? "t" : null };
        expect(draw({ ...base, audio: changed }).outerHTML).not.toBe(draw(base).outerHTML);
      }),
    );
  });

  it("a speaking patch keeps a class another module set on the live row", () => {
    fc.assert(
      fc.property(rowModel, (model) => {
        const el = draw({ ...model, speaking: false });
        el.classList.add("dragging");
        patchVoiceUserRow(el, { ...model, speaking: true });
        expect(el.classList.contains("dragging")).toBe(true);
        expect(el.classList.contains("speaking")).toBe(true);
        patchVoiceUserRow(el, { ...model, speaking: false });
        expect(el.classList.contains("dragging")).toBe(true);
        expect(el.classList.contains("speaking")).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it("the patch fields are exactly speaking, and never verify", () => {
    expect([...VOICE_USER_PATCH_FIELDS]).toEqual(["speaking"]);
  });
});
