export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach Kondo (or your sign-in expired — reload the page)", 0, null);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. a sign-in page); handled below.
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
};
