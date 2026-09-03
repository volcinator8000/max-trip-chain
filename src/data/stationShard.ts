/**
 * Naming for per-station shards, shared by the build scripts and the browser.
 *
 * A station's shard holds every leg where it is the origin OR the destination, across
 * the whole booking window. That layout is what makes a search cheap: an exact trip
 * needs just two files — `X→hub` is in X's shard and `hub→Y` is in Y's, so even a
 * one-change journey and its full 30-day calendar are answerable without touching the
 * rest of the network. The median station is ~17 KB gzipped for a month, against
 * ~500 KB for a single day of a whole country.
 *
 * Carrying each leg in both endpoints' shards doubles storage on the server. That is
 * deliberate: "which trains reach Y" is a first-class question in this app, and a
 * second reverse index would cost the same while adding a format to keep in step.
 */

/** Station ids contain spaces, accents and parentheses; file names should not. */
function slug(id: string): string {
  return id
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * FNV-1a, 32-bit. Small, dependency-free and identical in Node and the browser —
 * which is the only requirement, since both sides must derive the same file name.
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * File name for a station's shard: a readable slug plus a hash of the full id.
 *
 * The hash is what makes it safe. Slugs collide (accents folded away, long names
 * truncated) and a collision would silently serve one station's trains for another,
 * so identity comes from the hash and the slug is only there to make the directory
 * legible when debugging.
 */
export function stationFileName(stationId: string): string {
  const s = slug(stationId);
  return `${s || "x"}-${hash32(stationId)}.json`;
}
