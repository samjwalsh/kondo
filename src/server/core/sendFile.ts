import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
};

/**
 * Streams a file, honouring a single `Range: bytes=…` request so video players can seek.
 * Replies 404 if it isn't a readable file.
 */
export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
): Promise<FastifyReply> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return reply.code(404).send({ error: "Not found" });
  const size = info.size;
  reply
    .type(TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
    .header("accept-ranges", "bytes")
    .header(
      "content-disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    );

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range || (range[1] === "" && range[2] === "")) {
    return reply.header("content-length", size).send(createReadStream(file));
  }
  let start: number;
  let end: number;
  if (range[1] === "") {
    // "bytes=-500": the last 500 bytes.
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start >= size || start > end) {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }
  return reply
    .code(206)
    .header("content-range", `bytes ${start}-${end}/${size}`)
    .header("content-length", end - start + 1)
    .send(createReadStream(file, { start, end }));
}
