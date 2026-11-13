// Types shared by the request-emails tool's server code and its web page.

/**
 * - `sent`: the requester was emailed.
 * - `failed`: sending failed; retried on later checks until `attempts` reaches the limit.
 * - `skipped`: no email address, so nobody to tell.
 * - `before`: was already ready when Kondo started watching, so no email.
 */
export type NoticeStatus = "sent" | "failed" | "skipped" | "before";

export interface Notice {
  requestId: number;
  at: string;
  status: NoticeStatus;
  type: "movie" | "tv";
  title: string;
  /** e.g. "Season 1: 3 of 8 episodes". */
  detail: string | null;
  /** The requester's Seerr display name (never the email address). */
  user: string;
  attempts: number;
  error: string | null;
}

export interface RequestsStatus {
  enabled: boolean;
  /** What's missing before it can run, e.g. "Seerr API key". */
  missing: string[];
  checkedAt: string | null;
  lastError: string | null;
  /** Requests approved but not ready to watch yet. */
  waiting: number;
}

/** An approved request nobody can start watching yet, and why. */
export interface WaitingRequest {
  requestId: number;
  type: "movie" | "tv";
  title: string;
  user: string;
  requestedAt: string;
  requestStatus: "approved" | "completed";
  reason: string;
}
