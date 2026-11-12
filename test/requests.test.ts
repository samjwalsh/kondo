import { describe, expect, it } from "vitest";
import { coreMigrations, migrate, openDb } from "../src/server/core/db.js";
import type { EmailMessage } from "../src/server/integrations/email.js";
import type { SeerrRequest, SeerrTitle } from "../src/server/integrations/seerr.js";
import { firstSeason, MAX_ATTEMPTS, runCheck } from "../src/tools/requests/check.js";
import { buildMessage, readyLines } from "../src/tools/requests/message.js";
import { migrations, RequestsStore } from "../src/tools/requests/store.js";
import { tempDir } from "./helpers.js";

const movieRequest = (id: number, mediaStatus: number): SeerrRequest => ({
  id,
  status: 2,
  type: "movie",
  is4k: false,
  createdAt: "2026-11-01T00:00:00Z",
  media: { tmdbId: 100 + id, status: mediaStatus },
  requestedBy: { id: 7, email: "amy@example.com", displayName: "Amy" },
});

const showRequest = (id: number, seasons: number[], mediaStatus = 4): SeerrRequest => ({
  id,
  status: 2,
  type: "tv",
  is4k: false,
  createdAt: "2026-11-01T00:00:00Z",
  media: { tmdbId: 500, status: mediaStatus },
  seasons: seasons.map((seasonNumber) => ({ seasonNumber })),
  requestedBy: { id: 8, displayName: "Ben" },
});

function setup() {
  const db = openDb(tempDir());
  migrate(db, "core", coreMigrations);
  migrate(db, "tool:requests", migrations);
  const store = new RequestsStore(db);
  const state = {
    requests: [] as SeerrRequest[],
    movieStatus: new Map<number, number>(),
    seasonStatus: [{ seasonNumber: 1, status: 4 }] as { seasonNumber: number; status: number }[],
    plexEpisodes: [2, 3] as number[] | null,
    plexConfigured: true,
    sendError: null as Error | null,
  };
  const sent: EmailMessage[] = [];
  const seerr = {
    requests: async () => state.requests,
    userEmail: async (id: number) => (id === 8 ? "ben@example.com" : null),
    main: async () => ({ applicationUrl: "https://requests.example", applicationTitle: "Seerr" }),
    title: async (type: "movie" | "tv", tmdbId: number): Promise<SeerrTitle> =>
      type === "movie"
        ? {
            title: `Film ${tmdbId}`,
            year: "2025",
            posterPath: "/p.jpg",
            episodeCounts: new Map(),
            media: {
              status: state.movieStatus.get(tmdbId) ?? 5,
              seasons: [],
              ratingKey: "1",
              plexUrl: "https://app.plex.tv/x",
            },
          }
        : {
            title: "The Show",
            year: "2026",
            posterPath: null,
            episodeCounts: new Map([
              [1, 8],
              [2, 10],
            ]),
            media: { status: 4, seasons: state.seasonStatus, ratingKey: "55", plexUrl: null },
          },
  };
  const plex = {
    configured: () => state.plexConfigured,
    episodeNumbers: async () => state.plexEpisodes,
  };
  const email = {
    send: async (m: EmailMessage) => {
      if (state.sendError) throw state.sendError;
      sent.push(m);
    },
  };
  let now = Date.parse("2026-11-12T20:00:00Z");
  const check = () => {
    now += 5 * 60_000;
    return runCheck({ store, seerr, plex, email, now: () => now });
  };
  return { store, state, sent, check };
}

describe("request emails", () => {
  it("picks the lowest requested season, specials only when alone", () => {
    expect(firstSeason(showRequest(1, [3, 2, 0]))).toBe(2);
    expect(firstSeason(showRequest(1, [0]))).toBe(0);
    expect(firstSeason(showRequest(1, []))).toBeNull();
  });

  it("emails nobody on the first check, only about what becomes ready afterwards", async () => {
    const t = setup();
    t.state.requests = [movieRequest(1, 5), movieRequest(2, 3)];
    const first = await t.check();
    expect(first).toMatchObject({ sent: 0, before: 1, waiting: 1 });
    expect(t.sent).toHaveLength(0);

    t.state.requests = [movieRequest(1, 5), movieRequest(2, 5)];
    expect(await t.check()).toMatchObject({ sent: 1, before: 0, waiting: 0 });
    expect(t.sent).toMatchObject([
      { to: "amy@example.com", subject: "Film 102 is ready to watch" },
    ]);
    expect(t.sent[0]?.html).toContain("https://app.plex.tv/x");

    await t.check();
    expect(t.sent).toHaveLength(1);
    expect(t.store.recent({ limit: 10 })).toMatchObject([
      { requestId: 2, status: "sent", user: "Amy" },
    ]);
  });

  it("waits for episode 1 of the first requested season", async () => {
    const t = setup();
    await t.check(); // first check, nothing requested yet
    t.state.requests = [showRequest(3, [1, 2])];
    expect(await t.check()).toMatchObject({ sent: 0, waiting: 1 });

    t.state.plexEpisodes = [1, 2, 3];
    expect(await t.check()).toMatchObject({ sent: 1 });
    // The request list had no address, so it was looked up.
    expect(t.sent[0]?.to).toBe("ben@example.com");
    expect(t.sent[0]?.text).toContain("3 of 8 episodes of season 1 so far");
    expect(t.sent[0]?.text).toContain("The other seasons you asked for will follow.");
    expect(t.sent[0]?.text).toContain("https://requests.example/tv/500");
  });

  it("counts a complete season as ready without asking Plex", async () => {
    const t = setup();
    await t.check();
    t.state.seasonStatus = [{ seasonNumber: 1, status: 5 }];
    t.state.plexEpisodes = null;
    t.state.requests = [showRequest(4, [1], 5)];
    expect(await t.check()).toMatchObject({ sent: 1 });
    expect(t.sent[0]?.text).toContain("is now on Plex: all 8 episodes of season 1.");
  });

  it("ignores pending, declined and 4K requests", async () => {
    const t = setup();
    await t.check();
    t.state.requests = [
      { ...movieRequest(5, 5), status: 1 },
      { ...movieRequest(6, 5), status: 3 },
      { ...movieRequest(7, 5), is4k: true },
    ];
    expect(await t.check()).toMatchObject({ sent: 0, waiting: 0 });
  });

  it("retries a failed email, then gives up", async () => {
    const t = setup();
    await t.check();
    t.state.requests = [movieRequest(8, 5)];
    t.state.sendError = new Error("Resend refused the email: HTTP 403");
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await t.check();
    expect(t.store.get(8)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });

    // A fresh failure that then succeeds.
    t.state.requests = [movieRequest(9, 5)];
    await t.check();
    t.state.sendError = null;
    await t.check();
    expect(t.store.get(9)).toMatchObject({ status: "sent", attempts: 2 });
    expect(t.sent).toHaveLength(1);
  });

  it("records requesters without an email address", async () => {
    const t = setup();
    await t.check();
    t.state.requests = [
      { ...movieRequest(10, 5), requestedBy: { id: 99, displayName: "Local user" } },
    ];
    await t.check();
    expect(t.store.get(10)).toMatchObject({ status: "skipped", user: "Local user" });
    expect(t.sent).toHaveLength(0);
  });

  it("writes the email in plain words and escapes titles", () => {
    expect(readyLines({ type: "movie", title: "Heat", year: "1995", posterPath: null })).toEqual([
      "Heat (1995), which you requested, is now on Plex.",
    ]);
    const m = buildMessage(
      { type: "movie", title: "Tom & <Jerry>", year: null, posterPath: null },
      { userName: "Amy", plexUrl: null, seerrUrl: null, appTitle: "Seerr" },
    );
    expect(m.subject).toBe("Tom & <Jerry> is ready to watch");
    expect(m.html).toContain("Tom &amp; &lt;Jerry&gt;");
    expect(m.html).not.toContain("<Jerry>");
  });
});

describe("Seerr settings move", () => {
  it("moves the Seerr address from Needs a look to the Seerr integration", () => {
    const db = openDb(tempDir());
    migrate(db, "core", coreMigrations.slice(0, 2));
    db.prepare("INSERT INTO settings (scope, key, value) VALUES ('attention', 'seerrUrl', ?)").run(
      JSON.stringify("http://seerr:5055"),
    );
    migrate(db, "core", coreMigrations);
    const rows = db.prepare("SELECT scope, key, value FROM settings").all();
    expect(rows).toEqual([{ scope: "seerr", key: "url", value: '"http://seerr:5055"' }]);
  });
});
