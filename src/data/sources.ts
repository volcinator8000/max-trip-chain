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
 * That second point is why {@link buildPool} caches pool arrays by key: the same
 * request must return the SAME array back, or every search would miss the caches.
 */

import type { MaxTrain, SearchQuery } from "../types";
import { coverageFor, discountFor, type PassDefinition, type RouteBinding } from "./passes";
import { decodeShard } from "./shard";
import type { DatasetProfile } from "./profile";
import { addDays, dayIndex } from "../util/time";

/** How far ahead the booking window (and so the calendars) reach. */
export const BOOKING_WINDOW_DAYS = 30;

/** Shape of a shard directory's index.json, listing the days that actually exist. */
interface ShardIndex {
  v: number;
  days: { date: string; count: number }[];
  /** The network's busiest stations, published as its interchange hubs. */
  hubs?: string[];
}

/** What a source's index tells us: which days exist, and where trains can change. */
interface SourceIndex {
  dates: Set<string>;
  hubs: string[];
}

/** Per-source index, or null when the source published nothing. */
const indexCache = new Map<string, Promise<SourceIndex | null>>();
/** Hubs of every source loaded so far, so connection search can change trains there. */
const loadedHubs = new Map<string, string[]>();
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
function shardIndex(profile: DatasetProfile): Promise<SourceIndex | null> {
  const cached = indexCache.get(profile.id);
  if (cached) return cached;
  const dir = profile.shardDir;
  const p: Promise<SourceIndex | null> = dir
    ? fetchJson<ShardIndex>(`${dir}index.json`).then((idx) => {
        if (!idx || !Array.isArray(idx.days)) return null;
        // A network's hubs come from its own data, not from a list in the app: the
        // connection search only ever changes trains at a hub, so a network with none
        // would offer direct trains and nothing else.
        const hubs = Array.isArray(idx.hubs) ? idx.hubs : profile.hubs;
        loadedHubs.set(profile.id, hubs);
        return { dates: new Set(idx.days.map((d) => d.date)), hubs };
      })
    : Promise.resolve(null);
  indexCache.set(profile.id, p);
  return p;
}

/**
 * Every hub the search may change trains at: the French list, plus the published hubs
 * of each network whose data is loaded. Without the foreign hubs a cross-border search
 * could only ever return a direct train.
 */
export function activeHubs(baseHubs: string[]): string[] {
  const all = new Set(baseHubs);
  for (const hubs of loadedHubs.values()) {
    for (const h of hubs) all.add(h);
  }
  // Sorted so the value is stable: it feeds the connection cache key, and a set whose
  // order wandered would miss the cache on every search.
  return [...all].sort();
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
  const idx = await shardIndex(profile);
  if (!idx) return [];
  const wanted = dates.filter((d) => idx.dates.has(d));
  if (wanted.length === 0) return [];
  const loaded = await Promise.all(wanted.map((d) => loadShard(profile, d)));
  return loaded.flat();
}

/**
 * Load the extra trains for several sources at once, in parallel.
 *
 * A source that fails contributes nothing instead of failing the search — one network
 * being down should cost you that network, not the trip.
 */
export async function loadAllExtraTrains(profiles: DatasetProfile[], dates: string[]): Promise<MaxTrain[]> {
  const results = await Promise.all(
    profiles.map((p) => loadExtraTrains(p, dates).catch(() => [] as MaxTrain[])),
  );
  return results.flat();
}

/** Station registries published by shard-only sources, so foreign results map. */
export async function loadSourceStations(
  profile: DatasetProfile,
): Promise<{ id: string; label: string; lat: number; lng: number; country?: string }[]> {
  if (!profile.stationsUrl) return [];
  const list = await fetchJson<{ id: string; label: string; lat: number; lng: number; country?: string }[]>(
    profile.stationsUrl,
  );
  return Array.isArray(list) ? list : [];
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
export interface PoolRequest {
  /** The committed free-MAX snapshot. Never mutated — it is the fallback pool. */
  free: MaxTrain[];
  /** Trains from shards (paid SNCF and/or foreign networks). */
  extra: MaxTrain[];
  /** The subscriptions in force, including the rules that apply to everyone. */
  held: PassDefinition[];
  /** Named routes for route-bound season tickets, by pass id. */
  bindings: Record<string, RouteBinding>;
  /** True when the user asked to see trains their passes do NOT cover. */
  showPaid: boolean;
  /** Identity of this request; the same key must return the same array. */
  key: string;
}

/**
 * The array the search should run on, with each train's coverage worked out from the
 * passes held.
 *
 * `available` — the single flag the whole core reads — becomes "my passes cover this,
 * or I asked to see what they don't". So the pass rules reach every filter, connection
 * sweep and calendar without any of them knowing passes exist.
 *
 * Memoized under `key` (which must fold in the passes and bindings, not just the
 * dates) so repeated searches reuse one array identity and keep their warm connection
 * caches — see the module comment on why identity matters.
 */
export function buildPool(req: PoolRequest): MaxTrain[] {
  if (req.key === poolKey && poolArr) return poolArr;
  const { held, bindings, showPaid } = req;

  // Shard trains are mutated in place rather than copied. They are decoded solely to
  // be searched, this is the only writer, and coverage is fully recomputed on every
  // rebuild — whereas copying them would double the peak memory of a pool that can
  // hold over a million trains.
  for (const t of req.extra) {
    const coverage = coverageFor(t, held, bindings);
    t.coverage = coverage;
    t.discount = discountFor(t, held);
    t.available = showPaid || coverage !== "paid";
  }

  // The snapshot IS copied: it is the fallback pool and every other search reads it,
  // so it must come out of this unchanged. Note it is not purely free trains — rows
  // advertised with a MAX seat at stops the pass doesn't cover (Bruxelles, Genève)
  // arrive `free: false`, and they still run, so a paid search has to include them.
  const snapshot: MaxTrain[] = req.free.map((t) => {
    const coverage = coverageFor(t, held, bindings);
    return { ...t, coverage, discount: discountFor(t, held), available: showPaid || coverage !== "paid" };
  });

  poolArr = snapshot.concat(req.extra);
  poolKey = req.key;
  return poolArr;
}

/** Drop every cached shard, index and pool (used by tests). */
export function resetSources(): void {
  indexCache.clear();
  shardCache.clear();
  loadedHubs.clear();
  poolKey = "";
  poolArr = null;
}

/** True when `date` is inside the bookable window starting at `today`. */
export function inBookingWindow(date: string, today: string): boolean {
  const d = dayIndex(date) - dayIndex(today);
  return d >= 0 && d < BOOKING_WINDOW_DAYS;
}
