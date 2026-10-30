/**
 * Property tests for the voice channel row view (voiceRow.view.ts, chrome).
 *
 *  - changing any one chrome model field changes the wrapper's outerHTML
 *  - patchVoiceChannelChrome(drawVoiceChannelChrome(a), b) renders exactly
 *    like drawVoiceChannelChrome(b), for one patch field and for any pair of
 *    states that share the create-only fields
 *  - a patch leaves the roving tabindex, a foreign class and the participant
 *    list where they are
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  VOICE_CHROME_PATCH_FIELDS,
  drawVoiceChannelChrome,
  patchVoiceChannelChrome,
  type VoiceChannelChromeModel,
} from "../../src/features/channels/voiceRow.view";
import { assertEveryFieldDraws } from "../helpers/rowModelProperty";

const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);

const capacity = fc.record({ label: text, title: text });

/** The patchable part of a chrome model. */
const patchable = fc.record({
  passwordProtected: fc.boolean(),
  afk: fc.boolean(),
  joined: fc.boolean(),
  frozenReason: fc.option(text, { nil: null }),
  timeoutReason: fc.option(text, { nil: null }),
  capacity: fc.option(capacity, { nil: null }),
  mentionCount: fc.integer({ min: 0, max: 120 }),
});

const createOnly = fc.record({
  channelId: fc.integer({ min: 1, max: 100000 }),
  name: text,
  nsfw: fc.boolean(),
  private: fc.boolean(),
});

const chromeModel: fc.Arbitrary<VoiceChannelChromeModel> = fc
  .tuple(createOnly, patchable)
  .map(([a, b]) => ({ ...a, ...b }));

function mutateChrome(model: VoiceChannelChromeModel, field: string): VoiceChannelChromeModel {
  switch (field) {
    case "channelId":
      return { ...model, channelId: model.channelId + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "nsfw":
      return { ...model, nsfw: !model.nsfw };
    case "private":
      return { ...model, private: !model.private };
    case "passwordProtected":
      return { ...model, passwordProtected: !model.passwordProtected };
    case "afk":
      return { ...model, afk: !model.afk };
    case "joined":
      return { ...model, joined: !model.joined };
    case "frozenReason":
      return { ...model, frozenReason: model.frozenReason === null ? "down" : null };
    case "timeoutReason":
      return { ...model, timeoutReason: model.timeoutReason === null ? "later" : null };
    case "capacity":
      return {
        ...model,
        capacity:
          model.capacity === null
            ? { label: "1/5", title: "1 of 5" }
            : { label: `${model.capacity.label}x`, title: `${model.capacity.title}x` },
      };
    case "mentionCount":
      return { ...model, mentionCount: model.mentionCount + 1 };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("voice channel row view", () => {
  it("every chrome model field changes the wrapper's DOM", async () => {
    await assertEveryFieldDraws(chromeModel, drawVoiceChannelChrome, mutateChrome, {
      patch: { fields: VOICE_CHROME_PATCH_FIELDS, apply: patchVoiceChannelChrome },
    });
  });

  it("patching between any two states equals drawing the second", () => {
    fc.assert(
      fc.property(createOnly, patchable, patchable, (fixed, a, b) => {
        const el = drawVoiceChannelChrome({ ...fixed, ...a });
        patchVoiceChannelChrome(el, { ...fixed, ...b });
        expect(el.outerHTML).toBe(drawVoiceChannelChrome({ ...fixed, ...b }).outerHTML);
      }),
      { numRuns: 200 },
    );
  });

  it("a patch keeps the roving tabindex, a foreign class and the participant list", () => {
    fc.assert(
      fc.property(createOnly, patchable, patchable, (fixed, a, b) => {
        const wrapper = drawVoiceChannelChrome({ ...fixed, ...a });
        const item = wrapper.querySelector<HTMLElement>(".channel-item")!;
        item.tabIndex = 0;
        item.classList.add("channel-drop-indicator");
        const list = document.createElement("div");
        list.className = "voice-users-list";
        wrapper.appendChild(list);

        patchVoiceChannelChrome(wrapper, { ...fixed, ...b });

        expect(item.getAttribute("tabindex")).toBe("0");
        expect(item.classList.contains("channel-drop-indicator")).toBe(true);
        expect(wrapper.firstElementChild).toBe(item);
        expect(wrapper.lastElementChild).toBe(list);
        expect(wrapper.querySelector(".ch-restriction") !== null).toBe(b.timeoutReason !== null);
      }),
    );
  });

  it("the patch fields are exactly the ones patchVoiceChannelChrome handles", () => {
    expect(VOICE_CHROME_PATCH_FIELDS.toSorted()).toEqual([
      "afk",
      "capacity",
      "frozenReason",
      "joined",
      "mentionCount",
      "passwordProtected",
      "timeoutReason",
    ]);
  });
});
