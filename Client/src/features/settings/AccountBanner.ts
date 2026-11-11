/** Account tab banner: the banner file preparation and the banner colour and upload editor. */

import { createElement, appendChildren, setText } from "@lib/dom";
import { errorText, ApiClientError } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { type CropResult, cropImage } from "@lib/ui/imageCrop";
import { isAnimatedImage } from "@lib/ui/animatedStill";
import { isBannerColor } from "../profiles/banner";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { outcomeEl } from "./helpers";
import { accountText as t } from "../../i18n/account";
import { ACCEPTED_AVATAR_TYPES } from "./accountImageTypes";

/** Mirrors maxBannerFileBytes: what an animated banner, sent uncropped, may weigh. */
const MAX_BANNER_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/** A banner is shown 5:2; 1200 px wide keeps it sharp and under the server's 1920x960 cap. */
const BANNER_ASPECT = 2.5;
const BANNER_MAX_WIDTH = 1200;

/**
 * What goes up as the banner. A still picture is cropped to 5:2 and scaled
 * down; a GIF or an animated WebP/PNG goes as it is, since a canvas crop keeps
 * only its first frame. The banner strip cover-crops it instead.
 */
export async function prepareBannerFile(file: File): Promise<CropResult> {
  if (file.type === "image/gif" || (await isAnimatedFile(file))) {
    if (file.size > MAX_BANNER_BYTES) {
      return { ok: false, error: t("banner.tooLarge", { kb: String(MAX_BANNER_BYTES / 1024) }) };
    }
    return { ok: true, file };
  }
  return cropImage(file, { aspect: BANNER_ASPECT, maxWidth: BANNER_MAX_WIDTH, fileBase: "banner" });
}

/** WebP's animation flag sits in its header and APNG's acTL chunk comes
 *  before the first image data, so the head of the file is enough. */
const ANIMATION_SNIFF_BYTES = 64 * 1024;

async function isAnimatedFile(file: File): Promise<boolean> {
  if (file.type !== "image/webp" && file.type !== "image/png") return false;
  try {
    return isAnimatedImage(
      new Uint8Array(await file.slice(0, ANIMATION_SNIFF_BYTES).arrayBuffer()),
    );
  } catch {
    return false;
  }
}
/** What the colour picker shows while no colour is set (it cannot be empty). */
const BANNER_PICKER_DEFAULT = "#5865f2";

/** The banner colour editor's state, read by Save Profile. */
export interface BannerEditor {
  readonly el: HTMLDivElement;
  /** The colour as edited, or null when none is set. */
  readonly current: () => string | null;
  /** The colour to PATCH: undefined when unchanged, "" to clear. */
  readonly pending: () => string | undefined;
  /** Save Profile succeeded: what is shown is now what the server has. */
  readonly commit: () => void;
}

const storedBannerColor = (): string | null => {
  const colour = authStore.getState().user?.banner_color;
  return isBannerColor(colour) ? colour.toLowerCase() : null;
};

/** Colour picker, upload and remove for the signed-in user's banner. */
export function buildBannerEditor(
  options: SettingsOverlayOptions,
  onChange: () => void,
  signal: AbortSignal,
): BannerEditor {
  const el = createElement("div", { class: "account-banner-edit", "data-testid": "banner-editor" });
  const colourLabel = createElement(
    "div",
    { class: "account-field-label" },
    t("profile.bannerColor"),
  );
  const colourInput = createElement("input", {
    type: "color",
    "aria-label": t("profile.bannerColor"),
    "data-testid": "banner-color-input",
  });
  const clearBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "banner-color-clear" },
    t("profile.bannerColorClear"),
  );
  const uploadBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "banner-upload-btn" },
    t("profile.bannerUpload"),
  );
  const removeBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "banner-remove-btn" },
    t("profile.bannerRemove"),
  );
  const fileInput = createElement("input", {
    type: "file",
    accept: ACCEPTED_AVATAR_TYPES,
    style: "display:none",
    "data-testid": "banner-file-input",
  });
  const errorEl = outcomeEl("error", "banner-error");

  let saved = storedBannerColor();
  let current = saved;
  const showColour = (): void => {
    colourInput.value = current ?? BANNER_PICKER_DEFAULT;
    clearBtn.hidden = current === null;
  };
  showColour();

  colourInput.addEventListener(
    "input",
    () => {
      current = colourInput.value.toLowerCase();
      clearBtn.hidden = false;
      onChange();
    },
    { signal },
  );
  clearBtn.addEventListener(
    "click",
    () => {
      current = null;
      showColour();
      onChange();
    },
    { signal },
  );

  // Another device changed the colour: follow it, as the avatar does.
  const unsubColour = authStore.subscribeSelector(
    (st) => st.user?.banner_color ?? null,
    () => {
      saved = storedBannerColor();
      current = saved;
      showColour();
    },
  );
  // The remove button exists only while there is an image to remove.
  const syncRemove = (): void => {
    const banner = authStore.getState().user?.banner;
    removeBtn.hidden = typeof banner !== "string" || banner === "";
  };
  syncRemove();
  const unsubImage = authStore.subscribeSelector((st) => st.user?.banner ?? null, syncRemove);
  signal.addEventListener(
    "abort",
    () => {
      unsubColour?.();
      unsubImage?.();
    },
    { once: true },
  );

  const upload = options.onUploadBanner;
  const remove = options.onRemoveBanner;
  uploadBtn.hidden = upload === undefined;
  if (remove === undefined) removeBtn.hidden = true;

  uploadBtn.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    () => {
      const file = fileInput.files?.[0];
      if (file === undefined || upload === undefined) return;
      setText(errorEl, "");
      uploadBtn.disabled = true;
      setText(uploadBtn, t("profile.uploading"));
      void (async () => {
        try {
          const prepared = await prepareBannerFile(file);
          if (!prepared.ok) {
            setText(errorEl, prepared.error);
            return;
          }
          await upload(prepared.file);
        } catch (err) {
          // 404: the server advertises banners with attachment storage off, so
          // the upload route is not mounted.
          setText(
            errorEl,
            err instanceof ApiClientError && err.status === 404
              ? t("profile.bannerStorageOff")
              : errorText(err, t("profile.bannerUploadFailed")),
          );
        } finally {
          fileInput.value = "";
          uploadBtn.disabled = false;
          setText(uploadBtn, t("profile.bannerUpload"));
        }
      })();
    },
    { signal },
  );
  removeBtn.addEventListener(
    "click",
    () => {
      if (remove === undefined) return;
      setText(errorEl, "");
      removeBtn.disabled = true;
      void remove()
        .catch((err: unknown) => setText(errorEl, errorText(err, t("toast.bannerRemoveFailed"))))
        .finally(() => {
          removeBtn.disabled = false;
        });
    },
    { signal },
  );

  const colourRow = createElement("div", { class: "account-avatar-upload" });
  appendChildren(colourRow, colourInput, clearBtn);
  const imageRow = createElement("div", { class: "account-avatar-upload" });
  appendChildren(imageRow, fileInput, uploadBtn, removeBtn);
  appendChildren(el, colourLabel, colourRow, imageRow, errorEl);

  return {
    el,
    current: () => current,
    pending: () => (current === saved ? undefined : (current ?? "")),
    commit: () => {
      saved = current;
    },
  };
}
