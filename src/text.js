// Small text helpers shared by the aggregator and the renderers.

// Shorten to at most `max` characters, counting code points so an emoji is
// never cut in half (a lone surrogate breaks the QR encoder and looks broken).
export function truncate(str, max) {
  const chars = Array.from(str);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : str;
}
