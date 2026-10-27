import { writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { sendFile } from "../src/server/core/sendFile.js";
import { tempDir } from "./helpers.js";

describe("sending a file", () => {
  const file = path.join(tempDir(), "video.mkv");
  writeFileSync(file, "0123456789");
  const app = Fastify();
  app.get("/file", (request, reply) => sendFile(request, reply, file));
  app.get("/missing", (request, reply) => sendFile(request, reply, `${file}.gone`));

  const get = (url: string, range?: string) =>
    app.inject({ method: "GET", url, headers: range ? { range } : {} });

  it("sends the whole file with its type", async () => {
    const res = await get("/file");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("0123456789");
    expect(res.headers["content-type"]).toBe("video/x-matroska");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("sends the requested range so players can seek", async () => {
    let res = await get("/file", "bytes=2-4");
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe("234");
    expect(res.headers["content-range"]).toBe("bytes 2-4/10");
    res = await get("/file", "bytes=7-");
    expect(res.body).toBe("789");
    res = await get("/file", "bytes=-2");
    expect(res.body).toBe("89");
    expect((await get("/file", "bytes=20-")).statusCode).toBe(416);
  });

  it("answers 404 for a missing file", async () => {
    expect((await get("/missing")).statusCode).toBe(404);
  });
});
