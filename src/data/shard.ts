/**
 * Compact per-day train shard — the wire format for the (large) datasets that are
 * NOT the committed free-MAX snapshot: paid SNCF trains, and the foreign networks.
 *
 * Why a codec at all: the verbose record shape the SNCF snapshot uses costs ~180
 * bytes per train, which is fine for the ~64k free seats but not for the ~322k paid
 * ones (or a merged European pool). Station and line names repeat constantly, so a
 * per-shard string table plus integer times cuts a record to ~30 bytes — small
 * enough that a day's worth is a quick fetch even on mobile.
 *
 * One shard = one calendar date, so the app fetches only the days a search touches
 * (see {@link file://./sources.ts}). Shards are built by the data jobs and served as
 * static files; nothing here depends on the browser, so the build scripts share it.
 */

import type { MaxTrain } from "../types";

/** Current shard schema version — bumped if the tuple layout ever changes. */
export const SHARD_VERSION = 1;

/**
 * One train in a shard, positionally encoded:
 * `[originIdx, destIdx, departMin, arriveMin, trainNo, categoryIdx]`
 *
 * Indices point into the shard's `stations` / `categories` tables. `arriveMin` is
 * already absolute (past-midnight arrivals exceed 1440), so decoding never has to
 * re-derive the day rollover. `categoryIdx` is -1 when the source has no line label.
 */
export type ShardRow = [number, number, number, number, string, number];

export interface TrainShard {
  /** Schema version; a reader rejects anything it doesn't understand. */
  v: number;
  /** The single calendar date ("YYYY-MM-DD") every row in this shard runs on. */
  date: string;
  /** Profile id that produced the shard, e.g. "sncf-tgvmax" or "db-fernverkehr". */
  source: string;
  /** Operator label shown on the result badge, e.g. "SNCF" or "DB". */
  operator: string;
  /**
   * Whether these trains are covered by the source's free pass. Paid shards are
   * false; a hypothetical free-pass shard would be true. Decoded rows carry it as
   * `free`, and the inverse as `paid`.
   */
  free: boolean;
  /** String table: station labels referenced by row indices 0 and 1. */
  stations: string[];
  /** String table: line / train-type labels referenced by row index 5. */
  categories: string[];
  rows: ShardRow[];
}

/** Zero-padded "HH:MM" for a minutes-from-midnight value (wrapping past midnight). */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** A train as the encoder takes it: times already resolved to absolute minutes. */
export interface EncodableTrain {
  origin: string;
  destination: string;
  departMin: number;
  arriveMin: number;
  trainNo: string;
  category?: string;
}

/**
 * Build a shard from one date's trains, interning station and category names into
 * the shard's own string tables.
 */
export function encodeShard(
  date: string,
  trains: EncodableTrain[],
  meta: { source: string; operator: string; free: boolean },
): TrainShard {
  const stations: string[] = [];
  const stationIdx = new Map<string, number>();
  const categories: string[] = [];
  const categoryIdx = new Map<string, number>();

  const intern = (table: string[], index: Map<string, number>, value: string): number => {
    const seen = index.get(value);
    if (seen !== undefined) return seen;
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const rows: ShardRow[] = trains.map((t) => [
    intern(stations, stationIdx, t.origin),
    intern(stations, stationIdx, t.destination),
    t.departMin,
    t.arriveMin,
    t.trainNo,
    t.category ? intern(categories, categoryIdx, t.category) : -1,
  ]);

  return { v: SHARD_VERSION, date, source: meta.source, operator: meta.operator, free: meta.free, stations, categories, rows };
}

/**
 * Decode a shard into `MaxTrain`s.
 *
 * `available` is left equal to `free`: it means "usable by the search that is running
 * now", and it is the pool builder — not the codec — that decides whether paid trains
 * count for the current search. See {@link file://./sources.ts}.
 *
 * Returns an empty array for a malformed or future-versioned shard rather than
 * throwing, so one bad file degrades to "no extra trains" instead of a blank app.
 */
export function decodeShard(shard: unknown): MaxTrain[] {
  if (!shard || typeof shard !== "object") return [];
  const s = shard as Partial<TrainShard>;
  if (s.v !== SHARD_VERSION) return [];
  if (typeof s.date !== "string" || !Array.isArray(s.rows) || !Array.isArray(s.stations)) return [];
  const stations = s.stations;
  const categories = Array.isArray(s.categories) ? s.categories : [];
  const free = s.free === true;
  const source = typeof s.source === "string" ? s.source : "";
  const operator = typeof s.operator === "string" ? s.operator : "";
  const out: MaxTrain[] = [];
  for (const row of s.rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [oi, di, departMin, arriveMin, trainNo, ci] = row as ShardRow;
    const origin = stations[oi];
    const destination = stations[di];
    if (origin === undefined || destination === undefined) continue;
    if (typeof departMin !== "number" || typeof arriveMin !== "number") continue;
    const category = ci >= 0 ? categories[ci] : undefined;
    out.push({
      date: s.date,
      origin,
      destination,
      depart: hhmm(departMin),
      arrive: hhmm(arriveMin),
      departMin,
      arriveMin,
      durationMin: arriveMin - departMin,
      trainNo: typeof trainNo === "string" ? trainNo : "",
      available: free,
      free,
      paid: !free,
      source,
      operator,
      ...(category ? { axe: category } : {}),
    });
  }
  return out;
}
