// Track tags come as ISO 639-2/B ("fre"), 639-2/T ("fra"), 639-1 ("fr") or
// nothing at all; Sonarr/Radarr give names ("French"). Everything is
// normalised to 639-2/B, the form Matroska uses. `null` means "unknown".

const TERMINOLOGIC_TO_BIBLIOGRAPHIC: Record<string, string> = {
  fra: "fre",
  deu: "ger",
  zho: "chi",
  nld: "dut",
  ces: "cze",
  ell: "gre",
  fas: "per",
  ron: "rum",
  slk: "slo",
  sqi: "alb",
  hye: "arm",
  eus: "baq",
  kat: "geo",
  isl: "ice",
  mkd: "mac",
  msa: "may",
  mya: "bur",
  bod: "tib",
  cym: "wel",
  nob: "nor",
  nno: "nor",
};

const NAMES: Record<string, string> = {
  eng: "English",
  fre: "French",
  ger: "German",
  spa: "Spanish",
  ita: "Italian",
  por: "Portuguese",
  dut: "Dutch",
  swe: "Swedish",
  dan: "Danish",
  nor: "Norwegian",
  fin: "Finnish",
  ice: "Icelandic",
  pol: "Polish",
  cze: "Czech",
  slo: "Slovak",
  hun: "Hungarian",
  rum: "Romanian",
  bul: "Bulgarian",
  gre: "Greek",
  tur: "Turkish",
  rus: "Russian",
  ukr: "Ukrainian",
  srp: "Serbian",
  hrv: "Croatian",
  slv: "Slovenian",
  lit: "Lithuanian",
  lav: "Latvian",
  est: "Estonian",
  ara: "Arabic",
  heb: "Hebrew",
  per: "Persian",
  hin: "Hindi",
  tam: "Tamil",
  tel: "Telugu",
  ben: "Bengali",
  urd: "Urdu",
  tha: "Thai",
  vie: "Vietnamese",
  ind: "Indonesian",
  may: "Malay",
  tgl: "Tagalog",
  chi: "Chinese",
  jpn: "Japanese",
  kor: "Korean",
  gle: "Irish",
  wel: "Welsh",
  cat: "Catalan",
  baq: "Basque",
  glg: "Galician",
  lat: "Latin",
};

const ONE_LETTER_PAIRS: Record<string, string> = {
  en: "eng",
  fr: "fre",
  de: "ger",
  es: "spa",
  it: "ita",
  pt: "por",
  nl: "dut",
  sv: "swe",
  da: "dan",
  no: "nor",
  nb: "nor",
  nn: "nor",
  fi: "fin",
  is: "ice",
  pl: "pol",
  cs: "cze",
  sk: "slo",
  hu: "hun",
  ro: "rum",
  bg: "bul",
  el: "gre",
  tr: "tur",
  ru: "rus",
  uk: "ukr",
  sr: "srp",
  hr: "hrv",
  sl: "slv",
  ar: "ara",
  he: "heb",
  fa: "per",
  hi: "hin",
  ta: "tam",
  te: "tel",
  th: "tha",
  vi: "vie",
  id: "ind",
  ms: "may",
  zh: "chi",
  ja: "jpn",
  ko: "kor",
  ga: "gle",
  cy: "wel",
  ca: "cat",
};

const UNKNOWN = new Set(["", "und", "unk", "zxx", "mis", "mul", "xxx", "unknown"]);

const BY_NAME = new Map(Object.entries(NAMES).map(([code, name]) => [name.toLowerCase(), code]));
// Names Sonarr/Radarr use that aren't plain language names.
BY_NAME.set("flemish", "dut");
BY_NAME.set("brazilian", "por");
BY_NAME.set("latino", "spa");
BY_NAME.set("mandarin", "chi");
BY_NAME.set("cantonese", "chi");

/** A track's language tag → canonical code, or null when unknown. */
export function normalizeLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (UNKNOWN.has(t)) return null;
  if (t.length === 2) return ONE_LETTER_PAIRS[t] ?? null;
  if (t.length === 3) return TERMINOLOGIC_TO_BIBLIOGRAPHIC[t] ?? t;
  return BY_NAME.get(t) ?? null;
}

/** A language name from Sonarr/Radarr ("Portuguese (Brazil)") → code. */
export function languageFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.trim().toLowerCase().split(" (")[0] ?? "";
  if (base === "" || base === "any" || base === "unknown" || base === "original") return null;
  return BY_NAME.get(base) ?? null;
}

export function languageName(code: string | null): string {
  if (!code) return "Unlabelled";
  return NAMES[code] ?? code;
}

// Native spellings seen in track titles, besides the English names above.
const NATIVE_NAMES: Record<string, string> = {
  español: "spa",
  castellano: "spa",
  français: "fre",
  francais: "fre",
  deutsch: "ger",
  italiano: "ita",
  português: "por",
  portugues: "por",
  nederlands: "dut",
  svenska: "swe",
  dansk: "dan",
  norsk: "nor",
  suomi: "fin",
  polski: "pol",
  čeština: "cze",
  magyar: "hun",
  türkçe: "tur",
};

/** A language named in a track title ("English [CC]", "Español latino"), if exactly one is. */
export function languageFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const words = title
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const found = new Set<string>();
  for (const word of words) {
    const code = BY_NAME.get(word) ?? NATIVE_NAMES[word];
    if (code) found.add(code);
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}
