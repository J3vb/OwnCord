// A Map-backed Web Storage area for the browser platform bindings (6.13c),
// with one switch that makes every access throw — the shape a blocked or
// failing storage area takes in a real browser. Install it with
// `vi.stubGlobal("localStorage", area)` and undo with `vi.unstubAllGlobals()`.
export class FakeWebStorage {
  private readonly items = new Map<string, string>();
  /** When set, every read and write throws this. */
  failure: unknown = null;

  private guard(): void {
    if (this.failure !== null) throw this.failure;
  }

  get length(): number {
    this.guard();
    return this.items.size;
  }

  key(index: number): string | null {
    this.guard();
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.guard();
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.guard();
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.guard();
    this.items.delete(key);
  }

  clear(): void {
    this.guard();
    this.items.clear();
  }

  /** Every key, read past the failure switch, for assertions. */
  keys(): string[] {
    return [...this.items.keys()];
  }

  /** Every stored value, read past the failure switch, for assertions. */
  values(): string[] {
    return [...this.items.values()];
  }
}
