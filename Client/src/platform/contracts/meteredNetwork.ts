/** Device-wide network cost; independent of the connected server. */
export interface MeteredNetwork {
  isMetered(): boolean;
  start(signal: AbortSignal): Promise<void>;
}
