// The letter-avatar colour contract shared by the app (pickAvatarColor) and
// the server admin panel (core.js avatarColor): one palette, one hash. Both
// sides' tests pin these, so a change to either fails until both match.
export const AVATAR_PALETTE: readonly string[] = [
  "#5865f2",
  "#2e6db4",
  "#00796b",
  "#2f7d32",
  "#8a6d00",
  "#a35200",
  "#c62828",
  "#ad1457",
  "#7b3fb3",
  "#5c6b7a",
];

export const AVATAR_COLOR_SAMPLES: ReadonlyArray<readonly [username: string, colour: string]> = [
  ["", "#2f7d32"],
  ["a", "#a35200"],
  ["alice", "#7b3fb3"],
  ["Alice", "#2e6db4"],
  ["bob", "#5865f2"],
  ["carol", "#5c6b7a"],
  ["testuser", "#c62828"],
  ["otheruser", "#00796b"],
  ["user1", "#5c6b7a"],
  ["user2", "#2e6db4"],
  ["Zoë", "#00796b"],
  ["名前", "#5c6b7a"],
];
