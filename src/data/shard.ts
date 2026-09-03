/**
 * Compact train shard — the wire format for the datasets that are NOT the committed
 * free-MAX snapshot: paid SNCF trains, and the foreign networks.
 *
 * Why a codec at all: the verbose record shape the SNCF snapshot uses costs ~180
 * bytes per train, which is fine for the ~64k free seats but not for the ~322k paid
 * ones (or a merged European pool). Station and line names repeat constantly, so a
 * per-shard string table plus integer times cuts a record to ~30 bytes — small
 * enough that a day's worth is a quick fetch even on mobile.
 *
 * One shard = one STATION, holding every leg where it is the origin or destination
 * across the whole booking window (see {@link file://./stationShard.ts} for why).
 * A search therefore fetches a file per station it mentions, not a day of an entire
 * country. Shards are built by the data jobs and served as static files; nothing here
 * depends on the browser, so the build scripts share it.
 */

import type { MaxTrain } from "../types";

/** Current shard schema version — bumped if the tuple layout ever changes. */
export const SHARD_VERSION = 2;

/**
 * One train in a shard, positionally encoded:
 * `[originIdx, destIdx, departMin, arriveMin, trainIdx, categoryIdx, dateIdx]`
 *
 * Every field is an index into one of the shard's string tables, or a plain integer.
 * Train numbers are interned rather than inlined because one service becomes many
 * origin→destination rows — a Brussels regional train yields ~45 — and some feeds
 * use long identifiers; inlining them made train numbers alone two thirds of a
 * Belgian shard. `arriveMin` is already absolute (past-midnight arrivals exceed
 * 1440), so decoding never re-derives the day rollover. An index of -1 means the
 * source gave no value.
 */
export type ShardRow = [number, number, number, number, number, number, number];

export interface TrainShard {
  /** Schema version; a reader rejects anything it doesn't understand. */
  v: number;
  /** String table: the dates rows run on, referenced by row index 6. */
  dates: string[];
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
  /** String table: train numbers referenced by row index 4. */
  trains: string[];
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
  /** The calendar date this train runs ("YYYY-MM-DD"). */
  date: string;
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
  trains: EncodableTrain[],
  meta: { source: string; operator: string; free: boolean },
): TrainShard {
  const stations: string[] = [];
  const stationIdx = new Map<string, number>();
  const categories: string[] = [];
  const categoryIdx = new Map<string, number>();
  const trainNos: string[] = [];
  const trainNoIdx = new Map<string, number>();
  const dates: string[] = [];
  const dateIdx = new Map<string, number>();

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
    t.trainNo ? intern(trainNos, trainNoIdx, t.trainNo) : -1,
    t.category ? intern(categories, categoryIdx, t.category) : -1,
    intern(dates, dateIdx, t.date),
  ]);

  return {
    v: SHARD_VERSION,
    dates,
    source: meta.source,
    operator: meta.operator,
    free: meta.free,
    stations,
    trains: trainNos,
    categories,
    rows,
  };
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
  if (!Array.isArray(s.dates) || !Array.isArray(s.rows) || !Array.isArray(s.stations)) return [];
  const stations = s.stations;
  const dates = s.dates;
  const categories = Array.isArray(s.categories) ? s.categories : [];
  const trainNos = Array.isArray(s.trains) ? s.trains : [];
  const free = s.free === true;
  const source = typeof s.source === "string" ? s.source : "";
  const operator = typeof s.operator === "string" ? s.operator : "";
  const out: MaxTrain[] = [];
  for (const row of s.rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [oi, di, departMin, arriveMin, ti, ci, dtIdx] = row as ShardRow;
    const origin = stations[oi];
    const destination = stations[di];
    const date = dates[dtIdx];
    if (origin === undefined || destination === undefined || date === undefined) continue;
    if (typeof departMin !== "number" || typeof arriveMin !== "number") continue;
    const category = ci >= 0 ? categories[ci] : undefined;
    const trainNo = ti >= 0 ? (trainNos[ti] ?? "") : "";
    out.push({
      date,
      origin,
      destination,
      depart: hhmm(departMin),
      arrive: hhmm(arriveMin),
      departMin,
      arriveMin,
      durationMin: arriveMin - departMin,
      trainNo,
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
