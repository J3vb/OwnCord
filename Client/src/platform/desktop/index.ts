// The desktop platform implementation. B7-4 and B7-5 fill it in one
// capability at a time, moving call sites out of `src/lib` as each lands, so
// the registry stays `Partial<Platform>` until B7-5 adds the last member.
import { credentials } from "./credentials";
import { externalContent } from "./externalContent";
import { fileSaver } from "./fileSave";
import { http } from "./http";
import { identity } from "./identity";
import { logFiles } from "./logFiles";
import { pendingMessages } from "./pendingMessages";
import { settings } from "./settings";
import { socket } from "./socket";
import type { Platform } from "../contracts";

export const desktop: Partial<Platform> = {
  credentials,
  externalContent,
  fileSaver,
  http,
  identity,
  logFiles,
  pendingMessages,
  settings,
  socket,
};
