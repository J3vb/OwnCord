/**
 * The connection card's ping history: the last RTT samples of the current
 * call, in memory only. The widget empties it whenever the call it measures
 * changes (left, switched, or joined again after a drop), so a graph never
 * mixes one call's pings into another's.
 */

/** One sample every poll (2 s), so 60 cover the last two minutes at most. */
export const PING_HISTORY_SIZE = 60;

export interface PingHistory {
  /** Add one RTT sample in ms; a missing sample (0 or less) is skipped. */
  push(rtt: number): void;
  /** The samples, oldest first. */
  values(): readonly number[];
  /** Forget every sample. */
  reset(): void;
}

export function createPingHistory(size = PING_HISTORY_SIZE): PingHistory {
  const ring: number[] = [];
  let next = 0;

  return {
    push(rtt) {
      if (!(rtt > 0) || !Number.isFinite(rtt)) return;
      if (ring.length < size) {
        ring.push(rtt);
        return;
      }
      ring[next] = rtt;
      next = (next + 1) % size;
    },
    values() {
      return ring.length < size ? [...ring] : [...ring.slice(next), ...ring.slice(0, next)];
    },
    reset() {
      ring.length = 0;
      next = 0;
    },
  };
}

/** The sparkline's points in a `width` x `height` box: the oldest sample at
 *  the left, the newest at the right edge, a higher ping drawn higher. The
 *  scale starts at 0 ms and leaves headroom above the worst sample, so a
 *  steady line sits low and calm rather than filling the box with noise. */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
): Array<readonly [number, number]> {
  if (values.length === 0) return [];
  const top = Math.max(...values) * 1.5;
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const offset = values.length === 1 ? width : 0;
  return values.map((v, i) => {
    const x = offset + i * step;
    const y = height - (v / top) * height;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as const;
  });
}
