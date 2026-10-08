import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";

export const MAX_TEXT = 2000;

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const CONTROL = /[\x00-\x1f\x7f]/;
const OPAQUE_SCHEMES = new Set([
  "about",
  "blob",
  "chrome",
  "chrome-extension",
  "chrome-untrusted",
  "data",
  "devtools",
  "file",
  "filesystem",
  "intent",
  "javascript",
  "mailto",
  "sms",
  "tel",
  "view-source",
]);

export const normalizeUrl = (url: string): string => {
  let text = url.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  if (!text) throw new ToolError("navigate needs a URL, or back, forward or reload.");
  if (CONTROL.test(text)) {
    throw new ToolError("navigate does not open a URL containing control characters.");
  }
  if (text.toLowerCase() === "about:blank") return "about:blank";

  const match = SCHEME.exec(text);
  const hasExplicitScheme =
    match !== null &&
    match[1] !== undefined &&
    (text.slice(match[0].length).startsWith("//") || OPAQUE_SCHEMES.has(match[1].toLowerCase()));
  const scheme = hasExplicitScheme && match?.[1] !== undefined ? match[1].toLowerCase() : "https";
  if (!hasExplicitScheme) text = `https://${text}`;
  if (scheme !== "http" && scheme !== "https") {
    throw new ToolError(`navigate does not open ${scheme}: URLs; use an http or https address.`);
  }
  return text;
};

export const failurePhrase = (error: unknown): string => {
  const code = /net::ERR_[A-Z0-9_]+/.exec(String(error))?.[0];
  if (code === "net::ERR_BLOCKED_BY_CLIENT") return "The navigation was refused.";
  return code === undefined ? "The navigation failed." : `The navigation failed (${code}).`;
};

export const formatRemote = (remote: Readonly<Record<string, unknown>>): string => {
  if (remote["type"] === "undefined") return "undefined";
  if ("unserializableValue" in remote) return String(remote["unserializableValue"]);
  if ("value" in remote) {
    const value = remote["value"];
    if (typeof value === "string") return value;
    return JSON.stringify(value) ?? "undefined";
  }
  return String(remote["description"] ?? "");
};

const STOPWORDS = new Set(
  "a an the to for of on in at with and or that this is it its me my please find element elements".split(
    " ",
  ),
);
const ROLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  button: ["button"],
  btn: ["button"],
  link: ["link"],
  input: ["textbox", "searchbox", "combobox"],
  field: ["textbox", "searchbox", "combobox"],
  box: ["textbox", "searchbox", "checkbox"],
  textbox: ["textbox", "searchbox"],
  search: ["searchbox", "textbox", "combobox"],
  checkbox: ["checkbox"],
  radio: ["radio"],
  dropdown: ["combobox", "listbox"],
  select: ["combobox", "listbox"],
  menu: ["combobox", "menuitem"],
  image: ["img"],
  picture: ["img"],
  icon: ["img"],
  heading: ["heading"],
  title: ["heading"],
  tab: ["tab"],
};

export type RankCandidate = Readonly<Record<string, unknown>>;

const candidateText = (value: unknown): string => (value ? String(value) : "");
const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const rank = (query: string, candidates: readonly RankCandidate[]): RankCandidate[] => {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !STOPWORDS.has(word));
  const phrase = words.join(" ");
  const scored: Array<readonly [number, RankCandidate]> = [];

  for (const candidate of candidates) {
    const name = candidateText(candidate["name"]).toLowerCase();
    const attrs = candidateText(candidate["attrs"]).toLowerCase();
    const role = candidateText(candidate["role"]);
    if (role === "text") continue;
    let score = 0;
    for (const word of words) {
      const pattern = escaped(word);
      const roles = ROLE_WORDS[word];
      if (roles !== undefined) {
        if (roles.includes(role)) score += 3;
        else if (new RegExp(`\\b${pattern}`).test(name) || new RegExp(`\\b${pattern}`).test(attrs)) score += 1;
      } else if (new RegExp(`\\b${pattern}\\b`).test(name)) {
        score += 3;
      } else if (new RegExp(`\\b${pattern}`).test(name)) {
        score += 2;
      } else if (new RegExp(`\\b${pattern}`).test(attrs)) {
        score += 1;
      }
    }
    if (phrase && name.includes(phrase)) score += 5;
    if (score > 0) {
      score += 0.5 * Number(Boolean(candidate["interactive"]));
      score += 0.25 * Number(Boolean(candidate["visible"]));
      scored.push([score, candidate]);
    }
  }

  scored.sort((left, right) => right[0] - left[0]);
  return scored.map(([, candidate]) => candidate);
};
