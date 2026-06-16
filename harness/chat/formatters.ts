// Outbound text formatting for Telegram.
//
// - HTML escape inputs so accidental "<", "&", ">" don't corrupt the
//   parse mode. (We use parse_mode: 'HTML' on send.)
// - Chunk long messages on paragraph boundaries when possible, falling
//   back to mid-paragraph splits at the byte limit.
// - HTML-then-plaintext fallback is handled at the send layer in bot.ts,
//   not here — this module only produces strings.
//
// Matches openclaw's textChunkLimit / chunkMode behavior; defaults to
// 4000 to stay well under Telegram's 4096-character limit (which counts
// UTF-16 code units, not codepoints, so emoji can push a near-limit
// message over without warning).

const TELEGRAM_HARD_LIMIT = 4096;

/** Escape `< > &` so the string is safe inside `parse_mode: "HTML"`. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Split text into Telegram-safe chunks, preferring paragraph boundaries
 * (double-newline), then single-newline, then mid-paragraph if a single
 * paragraph itself exceeds the limit.
 *
 * Returns at least one chunk even for empty input (a single empty string)
 * so callers don't have to special-case zero-length replies.
 */
export function chunk(text: string, limit = 4000): string[] {
  const cap = Math.min(limit, TELEGRAM_HARD_LIMIT);
  if (text.length <= cap) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > cap) {
    // Try paragraph boundary first.
    let cut = remaining.lastIndexOf('\n\n', cap);
    // If no paragraph break in range, try single newline.
    if (cut <= 0) cut = remaining.lastIndexOf('\n', cap);
    // Last resort: split mid-paragraph at a space.
    if (cut <= 0) cut = remaining.lastIndexOf(' ', cap);
    // Truly last resort: hard cut at the limit (long URLs, code blocks, etc).
    if (cut <= 0) cut = cap;

    out.push(remaining.slice(0, cut).trimEnd());
    // Skip whitespace at the split boundary so the next chunk doesn't
    // start with stray newlines/spaces.
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining.length > 0) out.push(remaining);
  return out;
}

/**
 * Strip HTML tags for the plaintext-fallback path. Telegram occasionally
 * rejects HTML it generated itself if it contains unsupported tags or
 * malformed entities — bot.ts catches that and retries with plain text.
 */
export function stripHtml(s: string): string {
  // Remove tags repeatedly until the string stops changing — defensive
  // hardening so tag removal can't be defeated by crafted markup where a
  // removal makes fragments adjacent (CodeQL: incomplete multi-character
  // sanitization).
  let out = s;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);

  // Unescape entities with "&amp;" LAST. Decoding it first would turn
  // "&amp;lt;" (a literal "&lt;") into "<" — a double-unescape bug.
  return out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
