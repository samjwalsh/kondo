import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLibraryChange,
  PlexClient,
  parseSessions,
  parseUnmatched,
} from "../src/server/integrations/plex.js";

describe("plex sessions", () => {
  it("handles an idle server", () => {
    expect(parseSessions({ MediaContainer: { size: 0 } })).toEqual([]);
  });

  it("tells direct play, GPU and CPU transcodes apart", () => {
    const sessions = parseSessions({
      MediaContainer: {
        size: 3,
        Metadata: [
          {
            type: "episode",
            grandparentTitle: "NCIS",
            parentIndex: 5,
            index: 3,
            title: "Identity Crisis",
            User: { title: "sam" },
            Player: { title: "Living Room TV", state: "playing" },
            Media: [{ Part: [{ file: "/mnt/plexdrive/TV/NCIS/Season 05/NCIS - S05E03.mkv" }] }],
          },
          {
            type: "movie",
            title: "Catch Me If You Can",
            Player: { product: "Plex Web", state: "paused" },
            TranscodeSession: { videoDecision: "transcode", transcodeHwEncoding: "nvenc" },
          },
          {
            type: "movie",
            title: "I Love You, Man",
            TranscodeSession: { videoDecision: "transcode" },
          },
        ],
      },
    });
    expect(sessions).toEqual([
      {
        title: "NCIS S05E03 — Identity Crisis",
        user: "sam",
        player: "Living Room TV",
        state: "playing",
        transcode: "none",
        file: "/mnt/plexdrive/TV/NCIS/Season 05/NCIS - S05E03.mkv",
      },
      {
        title: "Catch Me If You Can",
        user: null,
        player: "Plex Web",
        state: "paused",
        transcode: "gpu",
        file: null,
      },
      {
        title: "I Love You, Man",
        user: null,
        player: null,
        state: "playing",
        transcode: "cpu",
        file: null,
      },
    ]);
  });

  it("doesn't count audio-only transcodes as video work", () => {
    const [s] = parseSessions({
      MediaContainer: { Metadata: [{ title: "x", TranscodeSession: { videoDecision: "copy" } }] },
    });
    expect(s?.transcode).toBe("none");
  });
});

describe("unmatched plex items", () => {
  it("keeps only items with a local guid (Plex's mark for 'no match')", () => {
    expect(
      parseUnmatched(
        {
          MediaContainer: {
            Metadata: [
              { ratingKey: "1", title: "Warrior", year: 2011, guid: "local://91277" },
              { ratingKey: "2", title: "Heat", year: 1995, guid: "plex://movie/5d776825" },
              { ratingKey: "3", title: "No Guid" },
            ],
          },
        },
        "Movies",
      ),
    ).toEqual([
      { id: "1", title: "Warrior (2011)", library: "Movies" },
      { id: "3", title: "No Guid", library: "Movies" },
    ]);
    expect(parseUnmatched({ MediaContainer: {} }, "Movies")).toEqual([]);
  });
});

describe("plex library notifications", () => {
  const timeline = (entries: object[]) => ({
    NotificationContainer: { type: "timeline", TimelineEntry: entries },
  });
  const lib = "com.plexapp.plugins.library";

  it("spots a film or episode that finished processing", () => {
    expect(isLibraryChange(timeline([{ identifier: lib, type: 1, state: 5 }]))).toBe(true);
    expect(isLibraryChange(timeline([{ identifier: lib, type: 4, state: 5 }]))).toBe(true);
  });

  it("ignores items still being processed, other types and other notifications", () => {
    expect(isLibraryChange(timeline([{ identifier: lib, type: 1, state: 0 }]))).toBe(false);
    expect(isLibraryChange(timeline([{ identifier: lib, type: 9, state: 5 }]))).toBe(false);
    expect(isLibraryChange(timeline([{ identifier: "other", type: 1, state: 5 }]))).toBe(false);
    expect(isLibraryChange({ NotificationContainer: { type: "playing" } })).toBe(false);
    expect(isLibraryChange({})).toBe(false);
  });
});

describe("re-analysing a replaced file", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new PlexClient({
      values: () => ({ url: "http://plex:32400" }),
      secret: () => "token",
    } as unknown as ConstructorParameters<typeof PlexClient>[0]);

  it("finds the episode by its exact path, then analyses it and starts deep analysis", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      const body = url.endsWith("/library/sections")
        ? {
            MediaContainer: {
              Directory: [
                { key: "1", type: "movie", Location: [{ path: "/media/Movies" }] },
                { key: "12", type: "show", Location: [{ path: "/media/TV/" }] },
              ],
            },
          }
        : { MediaContainer: { Metadata: [{ ratingKey: "91284" }] } };
      return new Response(JSON.stringify(body));
    });
    const plex = client();
    const file = "/media/TV/The Last of Us/Season 1/S01E05 & more.mkv";
    expect(await plex.itemForFile(file)).toBe("91284");
    const lookup = new URL(calls[1]?.url ?? "");
    expect(lookup.pathname).toBe("/library/sections/12/all");
    expect(lookup.searchParams.get("type")).toBe("4");
    // `file==` (exact), not `file=` (contains).
    expect(lookup.searchParams.get("file=")).toBe(file);

    await plex.analyze("91284");
    await plex.startDeepAnalysis();
    expect(calls.slice(2)).toEqual([
      { url: "http://plex:32400/library/metadata/91284/analyze", method: "PUT" },
      { url: "http://plex:32400/butler/DeepMediaAnalysis", method: "POST" },
    ]);
  });

  it("finds nothing outside Plex's libraries", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              Directory: [{ key: "1", type: "movie", Location: [{ path: "/media/Movies" }] }],
            },
          }),
        ),
    );
    expect(await client().itemForFile("/elsewhere/film.mkv")).toBeNull();
  });
});
