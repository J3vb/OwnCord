/** Account tab: the profile card, avatar and banner uploaders, and the profile fields. */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import { errorText, ApiClientError } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { avatarInitial } from "@lib/ui/avatar";
import { setAvatarSource, isRenderableAvatar } from "../../features/profiles/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "../../features/messaging/content/attachments";
import { type CropResult, cropImage } from "@lib/ui/imageCrop";
import { isAnimatedImage } from "@lib/ui/animatedStill";
import { isBannerColor } from "../../features/profiles/banner";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { outcomeEl, showOutcome } from "./helpers";
import { createRevealToggle } from "../../features/settings/status";
import { accountText as t } from "../../i18n/account";
import { connectText } from "../../i18n/connect";
import {
  attachLimitHint,
  MAX_DISPLAY_NAME_LEN,
  lineHintText,
  collapseSpaces,
  runeCount,
} from "@lib/text/nameLimits";

/** Mirrors the server's cap so the form can bound itself instead of learning
 *  about the limit from a rejected request (the name limits are in nameLimits). */
const MAX_ABOUT_LEN = 300;
/** Mirrors maxAvatarFileBytes / maxAvatarDimension on the server. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_DIMENSION = 1024;
/** Mirrors maxBannerFileBytes: what an animated banner, sent uncropped, may weigh. */
const MAX_BANNER_BYTES = 4 * 1024 * 1024;
/** Avatars and banners may move: GIF joins the still types. */
const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/webp,image/gif";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileCardResult {
  readonly card: HTMLDivElement;
  /** The coloured strip behind the avatar; `paintBanner` fills it. */
  readonly banner: HTMLDivElement;
  readonly headerName: HTMLDivElement;
  readonly headerHandle: HTMLDivElement;
  readonly usernameValue: HTMLDivElement;
  readonly editUsernameBtn: HTMLButtonElement;
  /** The big avatar; the uploader swaps its contents on success. */
  readonly avatarLarge: HTMLDivElement;
  /** Opened by Edit profile: avatar, display name, about and username. */
  readonly editor: HTMLDivElement;
}

// ---------------------------------------------------------------------------
// Profile card builder
// ---------------------------------------------------------------------------

export function buildProfileCard(
  displayName: string,
  username: string,
  signal: AbortSignal,
): ProfileCardResult {
  const card = createElement("div", { class: "account-card" });
  const banner = createElement("div", { class: "account-banner" });

  // Avatar overlapping the banner
  const avatarWrap = createElement("div", { class: "account-avatar-wrap" });
  const avatarLarge = createElement(
    "div",
    { class: "account-avatar-large", "data-testid": "account-avatar" },
    avatarInitial({ username, displayName }),
  );
  const statusDot = createElement("div", { class: "account-status-dot" });
  appendChildren(avatarWrap, avatarLarge, statusDot);

  // Header row
  const accountHeader = createElement("div", { class: "account-header" });
  const headerName = createElement("div", { class: "account-header-name" }, displayName);
  const headerHandle = createElement(
    "div",
    { class: "account-header-handle" },
    t("profile.handle", { username }),
  );
  const headerIdentity = createElement("div", { class: "account-header-identity" });
  appendChildren(headerIdentity, headerName, headerHandle);
  const editor = createElement("div", { class: "account-editor" });
  const editProfileBtn = createRevealToggle(
    t("profile.editProfile"),
    editor,
    signal,
    "profile-edit-toggle",
  );
  // The card's one accent action while closed; once open, Save Profile has it.
  editProfileBtn.classList.remove("secondary");
  editProfileBtn.addEventListener(
    "click",
    () => editProfileBtn.classList.toggle("secondary", !editor.hidden),
    { signal },
  );
  appendChildren(accountHeader, headerIdentity, editProfileBtn);

  // Username field row
  const fieldsContainer = createElement("div", { class: "account-fields" });
  const usernameField = createElement("div", { class: "account-field" });
  const usernameLeft = createElement("div", {});
  const usernameLabel = createElement(
    "div",
    { class: "account-field-label" },
    t("profile.username"),
  );
  const usernameValue = createElement("div", { class: "account-field-value" }, username);
  appendChildren(usernameLeft, usernameLabel, usernameValue);
  const editUsernameBtn = createElement(
    "button",
    { class: "account-field-edit" },
    t("profile.edit"),
  );
  appendChildren(usernameField, usernameLeft, editUsernameBtn);
  fieldsContainer.appendChild(usernameField);
  editor.appendChild(fieldsContainer);

  appendChildren(card, banner, avatarWrap, accountHeader, editor);

  return {
    card,
    banner,
    headerName,
    headerHandle,
    usernameValue,
    editUsernameBtn,
    avatarLarge,
    editor,
  };
}

// ---------------------------------------------------------------------------
// Avatar preview + uploader
// ---------------------------------------------------------------------------

/**
 * Draw `url` into the big avatar, replacing the letter. Falls back to the
 * letter when there is nothing to draw or the fetch fails, because the file
 * route is authenticated and `<img src>` cannot carry the session token.
 */
export function paintAvatar(
  target: HTMLDivElement,
  url: string | null,
  alt: string,
  initial: string,
): void {
  const showInitial = (): void => {
    target.replaceChildren(document.createTextNode(initial));
    target.style.background = "";
  };
  if (url === null) {
    delete target.dataset["avatarSrc"];
    showInitial();
    return;
  }
  // A later paint (a new upload, a user_update) wins over this one.
  target.dataset["avatarSrc"] = url;
  void fetchImageAsObjectUrl(url).then(async (objectUrl) => {
    const current = (): boolean => target.isConnected && target.dataset["avatarSrc"] === url;
    if (objectUrl === null || !current()) return;
    const img = createElement("img", { class: "avatar-img", alt });
    recoverEvictedImage(img, { url });
    if (!(await setAvatarSource(img, objectUrl, () => "always", current))) return;
    target.replaceChildren(img);
    target.style.background = "transparent";
  });
}

/**
 * Read a File into an object URL and measure it, so an image the server would
 * refuse is caught before a megabyte goes over the wire — and so the preview
 * shows what was actually picked rather than a spinner that ends in a 400.
 */
function measureImage(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      },
      { once: true },
    );
    img.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        resolve(null);
      },
      { once: true },
    );
    img.src = url;
  });
}

/** Local validation mirroring the server's rules. Returns an error message. */
export function validateAvatarFile(
  file: { size: number; type: string },
  dimensions: { width: number; height: number } | null,
): string | null {
  if (!ACCEPTED_AVATAR_TYPES.split(",").includes(file.type)) {
    return t("avatar.notImageOrGif");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return t("avatar.tooLarge", { kb: String(MAX_AVATAR_BYTES / 1024) });
  }
  if (dimensions === null) {
    return t("avatar.unreadable");
  }
  if (dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) {
    return t("avatar.tooWide", {
      width: String(MAX_AVATAR_DIMENSION),
      height: String(MAX_AVATAR_DIMENSION),
    });
  }
  return null;
}

export function buildAvatarUploader(
  options: SettingsOverlayOptions,
  avatarLarge: HTMLDivElement,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { class: "account-avatar-upload" });
  const input = createElement("input", {
    type: "file",
    accept: ACCEPTED_AVATAR_TYPES,
    style: "display:none",
    "data-testid": "avatar-file-input",
  });
  const uploadBtn = createElement(
    "button",
    { class: "ac-btn secondary", "data-testid": "avatar-upload-btn" },
    t("profile.changeAvatar"),
  );
  const removeBtn = createElement(
    "button",
    { class: "ac-btn secondary", "data-testid": "avatar-remove-btn" },
    t("profile.removeAvatar"),
  );
  const errorEl = outcomeEl("error", "avatar-error");

  // Shown only while there is an avatar to remove; follows the auth store so
  // an upload (or a user_update from another device) toggles it.
  const syncRemoveBtn = (): void => {
    removeBtn.hidden = !isRenderableAvatar(authStore.getState().user?.avatar);
  };
  syncRemoveBtn();
  const unsubAvatar = authStore.subscribeSelector((st) => st.user?.avatar, syncRemoveBtn);
  signal.addEventListener("abort", () => unsubAvatar?.(), { once: true });

  uploadBtn.addEventListener("click", () => input.click(), { signal });
  removeBtn.addEventListener(
    "click",
    () => {
      setText(errorEl, "");
      removeBtn.disabled = true;
      void (async () => {
        try {
          await options.onRemoveAvatar();
          const user = authStore.getState().user;
          paintAvatar(
            avatarLarge,
            null,
            user?.username ?? "avatar",
            avatarInitial({
              username: user?.username ?? "?",
              displayName: user?.display_name ?? null,
            }),
          );
        } catch (err) {
          // The old avatar stays; the handler has already toasted.
          setText(errorEl, errorText(err, t("toast.avatarRemoveFailed")));
        } finally {
          removeBtn.disabled = false;
        }
      })();
    },
    { signal },
  );

  input.addEventListener(
    "change",
    () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      setText(errorEl, "");
      void (async () => {
        const dimensions = await measureImage(file);
        const problem = validateAvatarFile(file, dimensions);
        if (problem !== null) {
          setText(errorEl, problem);
          input.value = "";
          return;
        }
        uploadBtn.disabled = true;
        setText(uploadBtn, t("profile.uploading"));
        try {
          const url = await options.onUploadAvatar(file);
          const user = authStore.getState().user;
          paintAvatar(
            avatarLarge,
            resolveServerUrl(url),
            user?.username ?? "avatar",
            avatarInitial({
              username: user?.username ?? "?",
              displayName: user?.display_name ?? null,
            }),
          );
        } catch (err) {
          setText(errorEl, errorText(err, t("profile.uploadFailed")));
        } finally {
          input.value = "";
          uploadBtn.disabled = false;
          setText(uploadBtn, t("profile.changeAvatar"));
        }
      })();
    },
    { signal },
  );

  appendChildren(wrapper, input, uploadBtn, removeBtn, errorEl);
  return wrapper;
}

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

// ---------------------------------------------------------------------------
// Display name + about
// ---------------------------------------------------------------------------

export function buildProfileFields(
  options: SettingsOverlayOptions,
  onSaved: (displayName: string) => void,
  signal: AbortSignal,
  bannerEditor: BannerEditor | null = null,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const separator = createElement("div", { class: "settings-separator" });
  const header = createElement(
    "div",
    { class: "settings-section-title" },
    t("profile.sectionTitle"),
  );

  const user = authStore.getState().user;

  const nameLabel = createElement(
    "div",
    { class: "account-field-label" },
    t("profile.displayName"),
  );
  const nameInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: t("profile.displayNamePlaceholder"),
    "data-testid": "display-name-input",
  });
  nameInput.value = user?.display_name ?? "";
  const nameHint = attachLimitHint(nameInput, {
    max: MAX_DISPLAY_NAME_LEN,
    hint: lineHintText(MAX_DISPLAY_NAME_LEN),
    countCharacters: true,
    id: "display-name-hint",
    signal,
  });
  nameHint.el.style.marginBottom = "12px";

  const aboutLabel = createElement("div", { class: "account-field-label" }, t("profile.about"));
  const aboutInput = createElement("textarea", {
    class: "form-input",
    rows: "3",
    placeholder: t("profile.aboutPlaceholder"),
    maxlength: String(MAX_ABOUT_LEN),
    style: "margin-bottom:8px;resize:vertical",
    "data-testid": "about-input",
  });
  aboutInput.value = user?.about ?? "";

  const statusEl = outcomeEl("error", "profile-error");
  statusEl.style.marginBottom = "8px";
  const saveBtn = createElement(
    "button",
    { class: "ac-btn", "data-testid": "profile-save-btn" },
    t("profile.save"),
  );

  saveBtn.addEventListener(
    "click",
    () => {
      // Collapsed like the server stores it: what is checked is what is sent.
      const displayName = collapseSpaces(nameInput.value);
      const about = aboutInput.value.trim();
      // A pasted or scripted value can exceed maxlength; never send one the
      // server would refuse. The typed text stays in the field.
      if (runeCount(displayName) > MAX_DISPLAY_NAME_LEN) {
        const message = connectText("limits.displayNameTooLong", { max: MAX_DISPLAY_NAME_LEN });
        nameHint.showError(message);
        showOutcome(statusEl, "error", connectText("limits.checkField"));
        return;
      }
      // Both are sent unconditionally, empty string included: "" is how the
      // API says "clear it", and omitting a field means "leave it alone".
      showOutcome(statusEl, "error", "");
      saveBtn.disabled = true;
      setText(saveBtn, t("profile.saving"));
      // Sent only when the colour was edited, so an unrelated save never
      // writes it (and an older server never sees the key).
      const bannerColor = bannerEditor?.pending();
      void options
        .onUpdateProfile({
          display_name: displayName,
          about,
          ...(bannerColor === undefined ? {} : { banner_color: bannerColor }),
        })
        .then(() => {
          bannerEditor?.commit();
          showOutcome(statusEl, "success", t("profile.saved"));
          onSaved(
            displayName.length > 0 ? displayName : (authStore.getState().user?.username ?? ""),
          );
        })
        .catch((err: unknown) => {
          const message = errorText(err, t("profile.saveFailed"));
          // The server's refusal (a character it does not allow) goes under
          // the field too, and what was typed stays put.
          if (err instanceof ApiClientError && /^display_name\b/i.test(err.message)) {
            nameHint.showError(message);
            showOutcome(statusEl, "error", connectText("limits.checkField"));
            return;
          }
          showOutcome(statusEl, "error", message);
        })
        .finally(() => {
          saveBtn.disabled = false;
          setText(saveBtn, t("profile.save"));
          if (focusIsOurs(saveBtn)) saveBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(
    wrapper,
    separator,
    header,
    nameLabel,
    nameInput,
    nameHint.el,
    aboutLabel,
    aboutInput,
    statusEl,
    saveBtn,
  );
  return wrapper;
}
