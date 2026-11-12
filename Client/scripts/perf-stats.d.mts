// Types for the Playwright measurements, which import the pure helpers from
// perf-stats.mjs. A declaration file rather than a second implementation, so
// the measurements and the analyzer cannot diverge.

export function quantile(sorted: readonly number[], q: number): number;
export function seededRandom(seed: number): () => number;

export interface BootstrapOptions {
  readonly iterations?: number;
  readonly seed?: number;
}

export function runBootstrapMedian(
  runs: readonly (readonly number[])[],
  options?: BootstrapOptions,
): [number, number];

export interface Summary {
  readonly n: number;
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  readonly ci95: [number, number];
}

export function summarize(
  runs: readonly (readonly number[])[],
  options?: BootstrapOptions,
): Summary;

export interface CounterDelta<E> {
  readonly entry: E;
  readonly isNew: boolean;
  readonly delta: Record<string, number>;
}

export function counterDeltas<E extends { readonly id: string }>(
  before: readonly E[],
  after: readonly E[],
  counters: readonly string[],
): { reset: boolean; reasons: string[]; deltas: CounterDelta<E>[] };

export interface SamplerOptions<S> {
  read(): Promise<S>;
  intervalMs?: number;
  maxSamples?: number;
  maxBytes?: number;
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Sampler<S> {
  start(): void;
  stop(): Promise<void>;
  samples(): S[];
  stats(): { kept: number; dropped: number; failures: number; bytes: number };
}

export function createSampler<S>(options: SamplerOptions<S>): Sampler<S>;
