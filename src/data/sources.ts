/**
 * Extra train sources and the SEARCH POOL built from them.
 *
 * The committed snapshot holds only trains with a free MAX seat. Anything else the
 * user asks to see — SNCF trains that run but cost money, and (later) foreign
 * networks — arrives as compact per-day shards fetched on demand.
 *
 * ## Why a "pool" rather than a flag
 *
 * The core search never learns what "paid" means. Instead this module hands it a
 * different ARRAY: free-only by default, or free-plus-paid when the toggle is on,
 * with `available` set true on everything the user asked to include. Two properties
 * fall out of that for free:
 *
 *  - The core keeps one `available` test. No filter, connection sweep or calendar
 *    needs a paid-aware branch, so paid mode cannot silently miss a code path.
 *  - `src/core/connections.ts` memoizes on the trains array IDENTITY (`WeakMap`).
 *    A different pool is a different array, so switching the toggle can never serve
 *    free-only results out of a warm cache — the caches simply don't collide.
 *
 * That second point is why {@link searchPool} caches pool arrays by key: the same
 * request must return the SAME array back, or every search would miss the caches.
 */

import type { MaxTrain, SearchQuery } from "../types";
import { decodeShard } from "./shard";
import type { DatasetProfile } from "./profile";
import { addDays, dayIndex } from "../util/time";

/** How far ahead the booking window (and so the calendars) reach. */
export const BOOKING_WINDOW_DAYS = 30;

/** Shape of a shard directory's index.json, listing the days that actually exist. */
interface ShardIndex {
  v: number;
  days: { date: string; count: number }[];
}

/** Per-source: the set of dates that have a shard, or null while unknown. */
const indexCache = new Map<string, Promise<Set<string> | null>>();
/** Per-source-and-date decoded shards, so a day is fetched at most once a session. */
const shardCache = new Map<string, Promise<MaxTrain[]>>();

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Which dates this source publishes. Resolves to null when the index is missing —
 * the deploy may not have generated shards — and callers then skip the source
 * entirely rather than firing a burst of 404s.
 */
function shardDates(profile: DatasetProfile): Promise<Set<string> | null> {
  const cached = indexCache.get(profile.id);
  if (cached) return cached;
  const dir = profile.shardDir;
  const p: Promise<Set<string> | null> = dir
    ? fetchJson<ShardIndex>(`${dir}index.json`).then((idx) =>
        idx && Array.isArray(idx.days) ? new Set(idx.days.map((d) => d.date)) : null,
      )
    : Promise.resolve(null);
  indexCache.set(profile.id, p);
  return p;
}

/**
 * Fetch and decode one day's shard. A missing or malformed shard resolves to an
 * empty array: a bad day degrades to "no extra trains then", never to a failed search.
 *
 * The decoded trains are marked usable here rather than in the codec. A shard is only
 * ever fetched because the user turned its source ON, so by the time it is decoded
 * "the user wants these trains" is exactly what `available` should say — while `free`
 * and `paid` keep recording what the train actually is, for the badge.
 */
function loadShard(profile: DatasetProfile, date: string): Promise<MaxTrain[]> {
  const key = `${profile.id}|${date}`;
  const cached = shardCache.get(key);
  if (cached) return cached;
  const p = fetchJson<unknown>(`${profile.shardDir ?? ""}${date}.json`).then((raw) => {
    const trains = decodeShard(raw);
    for (const t of trains) t.available = true;
    return trains;
  });
  shardCache.set(key, p);
  return p;
}

/**
 * Load every shard a search needs, in parallel. Days the source doesn't publish are
 * skipped without a request. Resolves to the flattened extra trains.
 */
export async function loadExtraTrains(profile: DatasetProfile, dates: string[]): Promise<MaxTrain[]> {
  if (!profile.shardDir) return [];
  const have = await shardDates(profile);
  if (!have) return [];
  const wanted = dates.filter((d) => have.has(d));
  if (wanted.length === 0) return [];
  const loaded = await Promise.all(wanted.map((d) => loadShard(profile, d)));
  return loaded.flat();
}

/**
 * The dates a search can touch: the whole booking window, because every mode draws a
 * 30-day availability calendar over it, plus any explicitly chosen day that falls
 * outside (a deep-linked past date, a return, a tour end).
 *
 * Deliberately the whole window rather than just the chosen day — a calendar that
 * showed paid days only for the date already selected would be worse than useless.
 */
export function datesForQuery(query: SearchQuery, today: string): string[] {
  const dates = new Set<string>();
  for (let i = 0; i < BOOKING_WINDOW_DAYS; i++) dates.add(addDays(today, i));
  for (const d of [query.date, query.returnDate, query.tourEndDate]) {
    if (d) dates.add(d);
  }
  for (const leg of query.legs ?? []) {
    if (leg.date) dates.add(leg.date);
  }
  return [...dates].sort();
}

// ---------------------------------------------------------------------------
// Pool assembly
// ---------------------------------------------------------------------------

let poolKey = "";
let poolArr: MaxTrain[] | null = null;

/**
 * The array the search should run on.
 *
 * With no extra trains this is the free snapshot itself — the default path stays
 * allocation-free and keeps its warm caches. Otherwise it is a combined array,
 * memoized under `key` so repeated searches over the same window reuse one identity
 * (see the module comment on why identity matters). The caller supplies the key
 * because only it knows what the extras represent; deriving one from array lengths
 * would let two different windows that happen to hold equal counts collide.
 */
export function searchPool(free: MaxTrain[], extra: MaxTrain[], key: string): MaxTrain[] {
  if (extra.length === 0) return free;
  if (key === poolKey && poolArr) return poolArr;
  poolArr = free.concat(extra);
  poolKey = key;
  return poolArr;
}

/** Drop every cached shard, index and pool (used by tests). */
export function resetSources(): void {
  indexCache.clear();
  shardCache.clear();
  poolKey = "";
  poolArr = null;
}

/** True when `date` is inside the bookable window starting at `today`. */
export function inBookingWindow(date: string, today: string): boolean {
  const d = dayIndex(date) - dayIndex(today);
  return d >= 0 && d < BOOKING_WINDOW_DAYS;
}
