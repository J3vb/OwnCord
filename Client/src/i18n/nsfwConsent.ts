import { defineCatalog } from "./format";

/** NSFW consent copy (B9-7): the pre-load gate and the withdraw control. */
export const nsfwConsentText = defineCatalog("nsfwConsent", {
  "gate.title": "#{name} is age-restricted",
  "gate.body":
    "A moderator marked this channel as age-restricted. Its messages, images and files are not loaded until you agree to view them.",
  "gate.scope":
    "Your choice is saved to your account on this server, so it applies on every device you sign in with. You can withdraw it at any time from this channel.",
  "gate.accept": "View channel",
  "gate.accepting": "Saving your choice…",
  "gate.decline": "Go back",
  "gate.failed":
    "Your choice could not be saved, so the channel stays hidden. Check your connection and try again.",
  "bar.text": "Age-restricted channel. You agreed to view its content.",
  "bar.revoke": "Withdraw consent",
  "bar.revokeFailed": "Consent could not be withdrawn. Try again.",
});
