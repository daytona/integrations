import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";

const aliases = (names: readonly string[], value: string): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, value]));

export const MODIFIERS = {
  ...aliases(["ctrl", "control", "control_l", "control_r", "ctl"], "ctrl"),
  ...aliases(["alt", "alt_l", "alt_r", "option", "opt"], "alt"),
  ...aliases(["shift", "shift_l", "shift_r"], "shift"),
  ...aliases(["cmd", "command", "super", "super_l", "super_r", "win", "windows", "meta", "meta_l"], "cmd"),
} as const;

export const NAMED = {
  ...aliases(["return", "enter"], "enter"), kp_enter: "num_enter",
  ...aliases(["escape", "esc"], "escape"), tab: "tab", backspace: "backspace",
  ...aliases(["delete", "del"], "delete"), space: "space", home: "home", end: "end",
  ...aliases(["page_up", "pageup", "prior", "pgup"], "pageup"),
  ...aliases(["page_down", "pagedown", "next", "pgdn"], "pagedown"),
  ...aliases(["insert", "ins"], "insert"),
  ...Object.fromEntries(["up", "down", "left", "right"].map((name) => [name, name])),
  ...Object.fromEntries(["up", "down", "left", "right"].map((name) => [`arrow${name}`, name])),
  ...aliases(["caps_lock", "capslock"], "capslock"), menu: "menu",
  ...aliases(["num_lock", "numlock"], "num_lock"),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, `f${index + 1}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`kp_${index}`, `num${index}`])),
  kp_add: "num_plus", kp_subtract: "num_minus", kp_multiply: "num_asterisk", kp_divide: "num_slash",
  kp_decimal: "num_decimal", kp_equal: "num_equal", minus: "-", equal: "=", bracketleft: "[",
  bracketright: "]", backslash: "\\", semicolon: ";", apostrophe: "'", comma: ",", period: ".",
  slash: "/", grave: "`",
} as const satisfies Record<string, string>;

export const SHIFTED = Object.fromEntries([..."!@#$%^&*()_+{}|:\"<>?~"].map((key, index) => [key, "1234567890-=[]\\;',./`"[index]!])) as Readonly<Record<string, string>>;
export const SHIFTED_NAMES = {
  exclam: "!", at: "@", numbersign: "#", dollar: "$", percent: "%", asciicircum: "^", ampersand: "&",
  asterisk: "*", parenleft: "(", parenright: ")", underscore: "_", plus: "+", braceleft: "{", braceright: "}",
  bar: "|", colon: ":", quotedbl: '"', less: "<", greater: ">", question: "?", asciitilde: "~",
} as const;
const PUNCTUATION = new Set("-=[]\\;',./`");

export const XKEYSYMS = {
  enter: "Return", num_enter: "KP_Enter", escape: "Escape", tab: "Tab", backspace: "BackSpace", delete: "Delete",
  space: "space", home: "Home", end: "End", pageup: "Prior", pagedown: "Next", insert: "Insert", up: "Up", down: "Down",
  left: "Left", right: "Right", capslock: "Caps_Lock", menu: "Menu", num_lock: "Num_Lock",
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, `F${index + 1}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`num${index}`, `KP_${index}`])),
  num_plus: "KP_Add", num_minus: "KP_Subtract", num_asterisk: "KP_Multiply", num_slash: "KP_Divide", num_decimal: "KP_Decimal", num_equal: "KP_Equal",
  "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", "\\": "backslash", ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "period", "/": "slash", "`": "grave",
  ctrl: "Control_L", alt: "Alt_L", shift: "Shift_L", cmd: "Super_L",
} as const satisfies Record<string, string>;

// Live production evidence (daemon 0.222.1, 2026-10-07): native press emits the wrong bytes for
// these names (`num_enter` emits backtick; operators emit unrelated characters). Their KP_* X
// keysyms emit the expected bytes. Digits, decimal, equal and lock remain correct natively.
export const XTEST_NUMPAD = new Set(["num_asterisk", "num_enter", "num_minus", "num_plus", "num_slash"]);
export const PLAYWRIGHT = {
  enter: "Enter", num_enter: "NumpadEnter", escape: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete", space: "Space",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  capslock: "CapsLock", menu: "ContextMenu", num_lock: "NumLock",
  ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, `F${index + 1}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`num${index}`, `Numpad${index}`])),
  num_plus: "NumpadAdd", num_minus: "NumpadSubtract", num_asterisk: "NumpadMultiply", num_slash: "NumpadDivide", num_decimal: "NumpadDecimal", num_equal: "=",
  ctrl: "Control", alt: "Alt", shift: "Shift", cmd: "Meta",
} as const satisfies Record<string, string>;

export type DesktopKey = Readonly<{ daytona: string | null; keysym: string; shift: boolean; char: string | null }>;

export const splitSequence = (text: string): string[] => {
  if (text && !text.trim()) return ["space"];
  const chords = text.split(/\s+/).filter(Boolean);
  if (!chords.length) throw new ToolError("No key was given; send a key name such as Return, or a chord such as ctrl+s.");
  return chords;
};

export const parseChord = (chord: string): [string[], string | null] => {
  if (chord === "+") return [[], "+"];
  const tokens = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
  if (tokens.some((token) => !token)) throw new ToolError(`Could not read the key chord ${JSON.stringify(chord)}; join keys with +, as in ctrl+s.`);
  const modifiers: string[] = [];
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIERS[token.toLowerCase() as keyof typeof MODIFIERS];
    if (!modifier) throw new ToolError(`${JSON.stringify(token)} is not a modifier; only the last key of a chord may be a plain key.`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const last = tokens[tokens.length - 1];
  if (last === undefined) throw new ToolError("Empty key chord");
  const final = MODIFIERS[last.toLowerCase() as keyof typeof MODIFIERS];
  if (final) { if (!modifiers.includes(final)) modifiers.push(final); return [modifiers, null]; }
  return [modifiers, last];
};

export const desktopKey = (token: string): DesktopKey => {
  if (token.length === 1) {
    if (token === " ") return { daytona: "space", keysym: "space", shift: false, char: " " };
    if (token in SHIFTED) { const base = SHIFTED[token] ?? token; return { daytona: base, keysym: XKEYSYMS[base as keyof typeof XKEYSYMS] ?? base, shift: true, char: token }; }
    if (/^[A-Z]$/.test(token)) return { daytona: token.toLowerCase(), keysym: token.toLowerCase(), shift: true, char: token };
    if (/^[a-zA-Z0-9]$/.test(token)) return { daytona: token, keysym: token, shift: false, char: token };
    if (PUNCTUATION.has(token)) return { daytona: token, keysym: XKEYSYMS[token as keyof typeof XKEYSYMS] ?? token, shift: false, char: token };
    return { daytona: null, keysym: `U${(token.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`, shift: false, char: token };
  }
  const lower = token.toLowerCase();
  const canonical = NAMED[lower as keyof typeof NAMED];
  if (canonical) {
    if (canonical.length === 1) return desktopKey(canonical);
    if (XTEST_NUMPAD.has(canonical)) return { daytona: null, keysym: XKEYSYMS[canonical as keyof typeof XKEYSYMS], shift: false, char: null };
    return { daytona: canonical, keysym: XKEYSYMS[canonical as keyof typeof XKEYSYMS], shift: false, char: null };
  }
  const shifted = SHIFTED_NAMES[lower as keyof typeof SHIFTED_NAMES];
  return shifted === undefined ? { daytona: null, keysym: token, shift: false, char: null } : desktopKey(shifted);
};

export const playwrightKey = (token: string): string => {
  if (token.length === 1) return token === " " ? "Space" : token;
  const canonical = NAMED[token.toLowerCase() as keyof typeof NAMED];
  if (canonical) return canonical.length === 1 ? canonical : PLAYWRIGHT[canonical as keyof typeof PLAYWRIGHT];
  return SHIFTED_NAMES[token.toLowerCase() as keyof typeof SHIFTED_NAMES] ?? token;
};

export const playwrightChord = (chord: string): string => {
  const [modifiers, token] = parseChord(chord);
  return [...modifiers.map((modifier) => PLAYWRIGHT[modifier as keyof typeof PLAYWRIGHT]), ...(token === null ? [] : [playwrightKey(token)])].join("+");
};
