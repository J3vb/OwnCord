export interface ChunkGate {
  promise: Promise<void>;
  open: () => void;
  fail: () => void;
}

/** A pending promise a test settles by hand: `open` resolves it, `fail` rejects it as a failed chunk load. */
export function makeGate(): ChunkGate {
  let open!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error("chunk load failed"));
  });
  promise.catch(() => {});
  return { promise, open, fail };
}
