// The connection generation counter. Every connect() and disconnect() moves it
// on, so a handler or timer that captured an earlier value knows its attempt
// was superseded. One counter is shared by every client in the page, exactly as
// it was when it lived in ws.ts.

let wsGeneration = 0;

export function currentGeneration(): number {
  return wsGeneration;
}

/** Invalidates every attempt that captured an earlier generation. */
export function bumpGeneration(): number {
  wsGeneration++;
  return wsGeneration;
}
