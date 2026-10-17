/** The member menu's Timeout lengths (server accepts 60..2419200 s). */
export const TIMEOUT_PRESETS = [
  { seconds: 60, key: "member.timeout.60s" },
  { seconds: 300, key: "member.timeout.5m" },
  { seconds: 600, key: "member.timeout.10m" },
  { seconds: 3600, key: "member.timeout.1h" },
  { seconds: 86400, key: "member.timeout.1d" },
  { seconds: 604800, key: "member.timeout.1w" },
] as const;
