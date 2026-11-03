export type Night = "first" | "second" | "both";
export const SECOND_NIGHT: ReadonlySet<string>;
export const SPLIT_BY_LINE: ReadonlySet<string>;
export function nightFromEnv(env: Readonly<Record<string, string | undefined>>): Night;
export function splitLine(text: string): { cut: number; lines: number };
export function filesForNight(
  files: readonly string[],
  night: Night,
  readText: (file: string) => string,
): string[];
