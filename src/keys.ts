/** Named key -> escape sequence. Names are lowercased before lookup. */
const NAMED: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  esc: "\x1b",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

export function keyToSequence(key: string): string {
  const name = key.trim().toLowerCase();
  if (name in NAMED) return NAMED[name];

  const ctrl = /^(?:ctrl|c)-(.)$/.exec(name) ?? /^ctrl\+(.)$/.exec(name);
  if (ctrl) {
    const c = ctrl[1];
    // ctrl+a..z -> 0x01..0x1a; also handles [ \ ] ^ _ which sit just past 'z'.
    const code = c.charCodeAt(0) & 0x1f;
    return String.fromCharCode(code);
  }

  const alt = /^(?:alt|meta|m)[-+](.+)$/.exec(name);
  if (alt) return "\x1b" + keyToSequence(alt[1]);

  if (key.length === 1) return key;
  throw new Error(
    `Unknown key "${key}". Use a single character, a named key (${Object.keys(NAMED).join(", ")}), or ctrl+X / alt+X.`,
  );
}
