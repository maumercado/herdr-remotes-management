// Turns raw terminal input into key names.

export type Key =
  | { name: "up" | "down" | "left" | "right" | "enter" | "escape" | "tab" | "backtab" | "backspace" | "home" | "end" | "pageup" | "pagedown" | "delete" }
  | { name: "ctrl"; char: string }
  | { name: "char"; char: string };

const SEQUENCES: [string, Key][] = [
  ["\x1b[A", { name: "up" }],
  ["\x1b[B", { name: "down" }],
  ["\x1b[C", { name: "right" }],
  ["\x1b[D", { name: "left" }],
  ["\x1bOA", { name: "up" }],
  ["\x1bOB", { name: "down" }],
  ["\x1bOC", { name: "right" }],
  ["\x1bOD", { name: "left" }],
  ["\x1b[H", { name: "home" }],
  ["\x1b[F", { name: "end" }],
  ["\x1bOH", { name: "home" }],
  ["\x1bOF", { name: "end" }],
  ["\x1b[1~", { name: "home" }],
  ["\x1b[4~", { name: "end" }],
  ["\x1b[3~", { name: "delete" }],
  ["\x1b[5~", { name: "pageup" }],
  ["\x1b[6~", { name: "pagedown" }],
  ["\x1b[Z", { name: "backtab" }],
];

/** Splits one chunk of input into keys. A lone ESC is the Escape key. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const seq = SEQUENCES.find(([s]) => rest.startsWith(s));
    if (seq) {
      keys.push(seq[1]);
      i += seq[0].length;
      continue;
    }
    if (rest.startsWith("\x1b[")) {
      // Unknown CSI sequence: skip up to its final byte.
      const end = rest.slice(2).search(/[\x40-\x7e]/);
      i += end < 0 ? rest.length : end + 3;
      continue;
    }
    const ch = data[i]!;
    i++;
    if (ch === "\x1b") keys.push({ name: "escape" });
    else if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch < " ") keys.push({ name: "ctrl", char: String.fromCharCode(ch.charCodeAt(0) + 96) });
    else {
      // Keep a surrogate pair together.
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff && i < data.length) {
        keys.push({ name: "char", char: ch + data[i]! });
        i++;
      } else keys.push({ name: "char", char: ch });
    }
  }
  return keys;
}
