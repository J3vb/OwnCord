export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

export function errorResponse(status: number, code: string, message: string): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ error: code, message }),
    headers: new Headers(),
  } as unknown as Response;
}

/** Error response whose json() throws (simulates non-JSON body). */
export function brokenJsonErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
    headers: new Headers(),
  } as unknown as Response;
}
