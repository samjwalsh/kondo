// fetch() with a timeout and error messages a person can act on.

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function request(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new HttpError(describeFetchError(error, url));
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " — check the token / API key"
        : response.status === 404
          ? " — check the address"
          : "";
    throw new HttpError(`HTTP ${response.status}${hint}`, response.status);
  }
  return response;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const response = await request(url, {
    ...init,
    headers: { accept: "application/json", ...init.headers },
  });
  try {
    return (await response.json()) as T;
  } catch {
    throw new HttpError("The response wasn't JSON — is that the right address?");
  }
}

function describeFetchError(error: unknown, url: string): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `${host} didn't answer in time`;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED") return `Nothing is listening at ${host}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Can't find ${host}`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `Can't reach ${host}`;
  return `Couldn't connect to ${host}${code ? ` (${code})` : ""}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
