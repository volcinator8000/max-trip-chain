/**
 * Pure GTFS-reading helpers, shared by the network converter (scripts/fetch-networks.ts).
 *
 * They live here rather than in the script because station identity is a data-layer
 * concern — whether two feeds mean the same station decides whether a cross-border
 * journey exists at all — and because keeping them free of Node imports makes them
 * directly testable.
 */

/**
 * Parse a GTFS time to minutes from the service day's midnight.
 *
 * GTFS deliberately allows hours ≥ 24 for a trip running past midnight ("25:30:00"),
 * which the app's own {@link file://../util/time.ts} parser rejects as malformed. The
 * extra hours are kept rather than wrapped, which is exactly the absolute arrival the
 * shard format wants. Returns NaN for anything unparseable.
 */
export function parseGtfsTime(value: string): number {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return NaN;
  return h * 60 + min;
}

/**
 * Split one CSV line, honouring double-quoted fields and doubled quotes ("" for a
 * literal quote) — GTFS follows RFC 4180, and station names really do contain commas
 * ("Hamburg, Hamburg Hbf").
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Reduce a feed's station name to a comparison key.
 *
 * Feeds disagree about stations in small, systematic ways: accents, punctuation, a
 * "(DE)" country tag, "Hbf" versus "Hauptbahnhof", a regional-transport mode prefix
 * ("S+U Berlin Hauptbahnhof"), a repeated city ("Hamburg, Hamburg Hbf"). Folding all
 * of those away means two feeds that mean the same station agree automatically, and
 * data/crosswalk.json only has to carry the genuine disagreements.
 */
export function normalizeStationName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*\((?:[a-z]{2,3})\)\s*$/, "") // trailing country tag
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\bhauptbahnhof\b/g, "hbf")
    .replace(/^(?:s\s+u|s|u)\s+(?=\S)/, "")
    .replace(/^(\S+)\s+\1\b/, "$1")
    .trim();
}

/**
 * The id a station is known by across every source.
 *
 * A crosswalk hit wins; otherwise the normalized name upper-cased, which makes two
 * feeds spelling a station the same way land on one id with no crosswalk entry at all.
 * Canonical ids are the SNCF label wherever SNCF also serves the station, so the
 * French half of a cross-border journey lands on the very same node.
 */
export function canonicalStationId(name: string, crosswalk: Map<string, string>): string {
  const key = normalizeStationName(name);
  return crosswalk.get(key) ?? key.toUpperCase();
}

/**
 * Build the lookup used by {@link canonicalStationId} from the crosswalk file's
 * `canonical id → feed-local names` shape. Keys beginning with "_" are documentation.
 */
export function buildCrosswalk(raw: Record<string, unknown>): Map<string, string> {
  const byName = new Map<string, string>();
  for (const [canonical, names] of Object.entries(raw)) {
    if (canonical.startsWith("_") || !Array.isArray(names)) continue;
    for (const n of names as string[]) byName.set(normalizeStationName(n), canonical);
  }
  return byName;
}
