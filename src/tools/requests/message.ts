// The "ready to watch" email. Plain HTML with inline styles: email clients ignore stylesheets.

export interface ReadyInfo {
  type: "movie" | "tv";
  title: string;
  year: string | null;
  posterPath: string | null;
  /** Shows: the first requested season and how much of it is on Plex. */
  season?: { number: number; have: number | null; total: number; complete: boolean };
  /** Shows: more seasons were requested than the one that's ready. */
  moreSeasons?: boolean;
}

export interface MessageContext {
  userName: string;
  plexUrl: string | null;
  seerrUrl: string | null;
  appTitle: string;
}

/** "Amy Jones" → "Amy": the email greets people by their first name. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** e.g. "Season 1: 3 of 8 episodes" — for Kondo's own page. */
const seasonName = (n: number) => (n === 0 ? "the specials" : `season ${n}`);

export function seasonDetail(info: ReadyInfo): string | null {
  const s = info.season;
  if (!s) return null;
  if (s.number === 0)
    return s.have === null ? "Specials" : `Specials: ${s.have} of ${s.total || "?"}`;
  if (s.complete) return `Season ${s.number}: all${s.total ? ` ${s.total}` : ""} episodes`;
  if (s.have === null) return `Season ${s.number}: some episodes`;
  return `Season ${s.number}: ${s.have}${s.total ? ` of ${s.total}` : ""} episodes`;
}

/** The sentences under the greeting, as plain text. */
export function readyLines(info: ReadyInfo): string[] {
  const name = info.year ? `${info.title} (${info.year})` : info.title;
  const s = info.season;
  if (info.type === "movie" || !s) return [`${name}, which you requested, is now on Plex.`];
  const lines: string[] = [];
  if (s.complete) {
    const all =
      s.total > 1 ? `all ${s.total} episodes of ${seasonName(s.number)}` : seasonName(s.number);
    lines.push(`${name}, which you requested, is now on Plex: ${all}.`);
  } else {
    const sofar =
      s.have === null
        ? `the first episodes of ${seasonName(s.number)}`
        : `${s.have}${s.total ? ` of ${s.total}` : ""} episode${s.have === 1 ? "" : "s"} of ${seasonName(s.number)} so far`;
    lines.push(`${name}, which you requested, has started arriving on Plex: ${sofar}.`);
    lines.push("The rest will follow as they come in.");
  }
  if (info.moreSeasons) lines.push("The other seasons you asked for will follow.");
  return lines;
}

export function buildMessage(
  info: ReadyInfo,
  ctx: MessageContext,
): { subject: string; html: string; text: string } {
  const subject = `${info.title} is ready to watch`;
  const lines = readyLines(info);
  const link = ctx.plexUrl
    ? { url: ctx.plexUrl, label: "Watch on Plex" }
    : ctx.seerrUrl
      ? { url: ctx.seerrUrl, label: `Open in ${ctx.appTitle}` }
      : null;
  const footer = `You're getting this because you asked for it on ${ctx.appTitle}.`;

  const text = [
    `Hi ${ctx.userName},`,
    "",
    ...lines,
    ...(link ? ["", `${link.label}: ${link.url}`] : []),
    "",
    footer,
  ].join("\n");

  const poster = info.posterPath
    ? `<td width="120" valign="top" style="padding-right:20px"><img src="https://image.tmdb.org/t/p/w300${esc(info.posterPath)}" width="120" alt="" style="display:block;border-radius:6px"></td>`
    : "";
  const button = link
    ? `<p style="margin:20px 0 0"><a href="${esc(link.url)}" style="display:inline-block;background:#e5a00d;color:#1f1f1f;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:6px">${esc(link.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1f1f">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px"><tr><td style="padding:24px">
<p style="margin:0 0 16px">Hi ${esc(ctx.userName)},</p>
<table role="presentation"><tr>${poster}<td valign="top">
<p style="margin:0 0 4px;font-size:20px;font-weight:bold">${esc(info.title)}</p>
${lines.map((l) => `<p style="margin:8px 0 0;line-height:1.5">${esc(l)}</p>`).join("\n")}
${button}
</td></tr></table>
<p style="margin:24px 0 0;font-size:12px;color:#71717a">${esc(footer)}</p>
</td></tr></table></body></html>`;

  return { subject, html, text };
}
