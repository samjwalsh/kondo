import { describe, expect, it } from "vitest";
import { parseSessions } from "../src/server/integrations/plex.js";

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
