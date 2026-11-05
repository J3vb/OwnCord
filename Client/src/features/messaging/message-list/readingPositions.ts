// Where the reader left each channel's list, for this session: the topmost
// message row in view and how far the view's top sat below that row's top.
// A revisit with nothing new opens there instead of at the bottom; a list
// left at its bottom stores nothing, so the next visit follows the tail.
import { registerSessionReset } from "@lib/net/sessionRegistry";

export interface ReadingPosition {
  readonly messageId: number;
  readonly offset: number;
}

const positions = new Map<number, ReadingPosition>();
// App-lifetime: the module-level map lives as long as the page; the reset clears it per session.
void registerSessionReset("readingPositions:byChannel", clearReadingPositions);

/** Forget every channel's position (the session ended). */
export function clearReadingPositions(): void {
  positions.clear();
}

/** Record where the reader left `channelId`; null forgets it (left at the bottom). */
export function rememberReadingPosition(channelId: number, pos: ReadingPosition | null): void {
  if (pos === null) positions.delete(channelId);
  else positions.set(channelId, pos);
}

/** The position `channelId` was left at, removed so it is used at most once. */
export function takeReadingPosition(channelId: number): ReadingPosition | null {
  const pos = positions.get(channelId) ?? null;
  positions.delete(channelId);
  return pos;
}
