/** The member picker loads on first use, so its code stays out of the main-page chunk. */
import { createLazyScreen } from "@lib/ui/lazyScreen";

export const memberPickerScreen = createLazyScreen(
  "member-picker",
  () => import("./MemberPickerModal"),
);
