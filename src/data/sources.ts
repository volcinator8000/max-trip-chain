/**
 * Extra train sources and the SEARCH POOL built from them.
 *
 * The committed snapshot holds only trains with a free MAX seat. Anything else the
 * user asks to see — SNCF trains that run but cost money, and the foreign networks —
 * arrives as per-STATION shards, fetched for the stations a search actually mentions.
 *
 * ## Why per-station
 *
 * A station's shard carries every leg where it is the origin or the destination, for
 * the whole booking window. So an exact trip needs exactly two files: `X→hub` is in
 * X's shard and `hub→Y` is in Y's, which answers direct trains, one-change journeys
 * and the full 30-day calendar without touching the rest of the network. The median
 * station is ~17 KB gzipped for a month; a single day of a whole country is ~500 KB.
 *
 * ## Why a "pool" rather than a flag
 *
 * The core search never learns what "paid" means. Instead this module hands it a
 * different ARRAY: free-only by default, or free-plus-extras, with `available` set
 * from the passes held. Two properties fall out of that for free:
 *
 *  - The core keeps one `available` test. No filter, connection sweep or calendar
 *    needs a paid-aware branch, so paid mode cannot silently miss a code path.
 *  - `src/core/connections.ts` memoizes on the trains array IDENTITY (`WeakMap`).
 *    A different pool is a different array, so changing sources can never serve stale
 *    results out of a warm cache — the caches simply don't collide.
 *
 * That second point is why {@link buildPool} caches pool arrays by key: the same
 * request must return the SAME array back, or every search would miss the caches.
 */

import type { MaxTrain, SearchQuery } from "../types";
import { coverageFor, discountFor, type PassDefinition, type RouteBinding } from "./passes";
import { decodeShard } from "./shard";
import { stationFileName } from "./stationShard";
import type { DatasetProfile } from "./profile";
import { dayIndex, addDays } from "../util/time";

/** How far ahead the booking window (and so the calendars) reach. */
export const BOOKING_WINDOW_DAYS = 30;

/** Shape of a shard directory's index.json. */
interface ShardIndex {
  v: number;
  /** The network's busiest stations, published as its interchange hubs. */
  hubs?: string[];
  /** Legs held in each station's shard — used to fetch cheap files first. */
  counts?: Record<string, number>;
}

/** What a source's index tells us: where trains can change, and what each file costs. */
interface SourceIndex {
  hubs: string[];
  counts: Record<string, number>;
}

/** Per-source index, or null when the source published nothing. */
const indexCache = new Map<string, Promise<SourceIndex | null>>();
/** Hubs of every source loaded so far, so connection search can change trains there. */
const loadedHubs = new Map<string, string[]>();
/**
 * Decoded station shards, keyed by source and station id.
 *
 * Unbounded on purpose. A station's shard is the whole month for one place — the
 * median is a few thousand legs — so holding every station a user visits in a session
 * is far cheaper than the per-day scheme it replaced, where one Belgian day alone was
 * ~99k trains and ~25 MB.
 */
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
 * What this source publishes. Resolves to null when the index is missing — the deploy
 * may not have generated shards — and callers then skip the source entirely rather
 * than firing a burst of 404s.
 */
function shardIndex(profile: DatasetProfile): Promise<SourceIndex | null> {
  const cached = indexCache.get(profile.id);
  if (cached) return cached;
  const dir = profile.shardDir;
  const p: Promise<SourceIndex | null> = dir
    ? fetchJson<ShardIndex>(`${dir}index.json`).then((idx) => {
        if (!idx) return null;
        // A network's hubs come from its own data, not from a list in the app: the
        // connection search only ever changes trains at a hub, so a network with none
        // would offer direct trains and nothing else.
        const hubs = Array.isArray(idx.hubs) && idx.hubs.length ? idx.hubs : profile.hubs;
        loadedHubs.set(profile.id, hubs);
        return { hubs, counts: idx.counts ?? {} };
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
 * Fetch and decode one station's shard. A missing or malformed shard resolves to an
 * empty array: a station with no file degrades to "no extra trains there", never to a
 * failed search.
 *
 * The decoded trains are marked usable here rather than in the codec. A shard is only
 * ever fetched because the user turned its source ON, so by the time it is decoded
 * "the user wants these trains" is exactly what `available` should say — while `free`
 * and `paid` keep recording what the train actually is, for the badge.
 */
function loadStationShard(profile: DatasetProfile, stationId: string): Promise<MaxTrain[]> {
  const key = `${profile.id}|${stationId}`;
  const cached = shardCache.get(key);
  if (cached) return cached;
  const p = fetchJson<unknown>(`${profile.shardDir ?? ""}s/${stationFileName(stationId)}`).then((raw) => {
    const trains = decodeShard(raw);
    for (const t of trains) t.available = true;
    return trains;
  });
  shardCache.set(key, p);
  return p;
}

/** Whether a station's shard is already decoded and held. */
export function stationLoaded(sourceId: string, stationId: string): boolean {
  return shardCache.has(`${sourceId}|${stationId}`);
}

/** How many legs a station's shard holds, per the index (0 when unknown). */
export async function stationCost(profile: DatasetProfile, stationId: string): Promise<number> {
  const idx = await shardIndex(profile);
  return idx?.counts[stationId] ?? 0;
}

/** Legs per station, as the source published them — the traffic ranking signal. */
export async function sourceCounts(profile: DatasetProfile): Promise<Record<string, number>> {
  const idx = await shardIndex(profile);
  return idx?.counts ?? {};
}

/** The hubs a source publishes, once its index is known. */
export async function hubsOf(profile: DatasetProfile): Promise<string[]> {
  const idx = await shardIndex(profile);
  return idx?.hubs ?? [];
}

/**
 * Load the shards for a set of stations, in parallel, and return their trains with
 * duplicates removed.
 *
 * Deduplication matters: a leg is filed under BOTH its endpoints, so fetching X and Y
 * yields every X→Y train twice. Left in, the search would offer each journey twice.
 */
export async function loadStationTrains(
  profile: DatasetProfile,
  stationIds: string[],
): Promise<MaxTrain[]> {
  if (!profile.shardDir || stationIds.length === 0) return [];
  const idx = await shardIndex(profile);
  if (!idx) return [];
  // When the index lists counts, trust it: a station missing from it has no shard, and
  // requesting one would just be a 404 per station per search. An index without counts
  // (an older build) tells us nothing, so everything is attempted.
  const known = Object.keys(idx.counts).length > 0;
  const wanted = stationIds.filter((id) => (known ? (idx.counts[id] ?? 0) > 0 : true));
  if (wanted.length === 0) return [];
  const loaded = await Promise.all(wanted.map((id) => loadStationShard(profile, id)));
  const seen = new Set<string>();
  const out: MaxTrain[] = [];
  for (const list of loaded) {
    for (const t of list) {
      const key = `${t.date}|${t.origin}>${t.destination}|${t.departMin}|${t.trainNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Load the given stations across several sources at once.
 *
 * A source that fails contributes nothing instead of failing the search — one network
 * being down should cost you that network, not the trip.
 */
export async function loadAllStationTrains(
  profiles: DatasetProfile[],
  stationIds: string[],
): Promise<MaxTrain[]> {
  const results = await Promise.all(
    profiles.map((p) => loadStationTrains(p, stationIds).catch(() => [] as MaxTrain[])),
  );
  return results.flat();
}

/** Station registries published by shard-only sources, so foreign results map. */
export async function loadSourceStations(
  profile: DatasetProfile,
): Promise<{ id: string; label: string; lat: number; lng: number; country?: string; aliases?: string[] }[]> {
  if (!profile.stationsUrl) return [];
  const list = await fetchJson<
    { id: string; label: string; lat: number; lng: number; country?: string; aliases?: string[] }[]
  >(profile.stationsUrl);
  return Array.isArray(list) ? list : [];
}

/** Station registries of sources the user has NOT enabled, cached per source. */
const disabledStationCache = new Map<string, Promise<{ id: string; label: string; aliases?: string[] }[]>>();

/**
 * Find a typed station name among networks that are switched OFF.
 *
 * A name the app cannot resolve looks like a typo, and is shown as one. But the app
 * often DOES know the place — it just hasn't been asked to search that country. This
 * turns that dead end into an offer, and is the only reason a disabled source's
 * station list is ever fetched (they are a few tens of KB each).
 */
export async function findInDisabledSources(
  text: string,
  profiles: DatasetProfile[],
  normalize: (s: string) => string,
): Promise<{ profile: DatasetProfile; label: string } | null> {
  const wanted = normalize(text);
  if (!wanted) return null;
  for (const profile of profiles) {
    if (!profile.stationsUrl) continue;
    let list = disabledStationCache.get(profile.id);
    if (!list) {
      list = loadSourceStations(profile).catch(() => []);
      disabledStationCache.set(profile.id, list);
    }
    for (const st of await list) {
      if (normalize(st.label) === wanted || normalize(st.id) === wanted) {
        return { profile, label: st.label };
      }
      if ((st.aliases ?? []).some((a) => normalize(a) === wanted)) return { profile, label: st.label };
    }
  }
  return null;
}

/**
 * The stations a query refers to — the shards a search needs.
 *
 * This is the whole economy of the design: a search fetches the places it names, not
 * a day of every train in a country.
 */
export function stationsForQuery(query: SearchQuery): string[] {
  const ids = new Set<string>();
  const add = (id: string | undefined): void => {
    if (id) ids.add(id);
  };
  add(query.origin);
  add(query.destination);
  add(query.via);
  for (const city of query.cities ?? []) add(city);
  for (const leg of query.legs ?? []) {
    add(leg.from);
    add(leg.to);
  }
  return [...ids];
}

/** Every day of the booking window — what the availability calendars sweep. */
export function calendarDates(today: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < BOOKING_WINDOW_DAYS; i++) out.push(addDays(today, i));
  return out;
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
    const discount = discountFor(t, held);
    t.coverage = coverage;
    t.discount = discount?.discountPercent ?? 0;
    t.discountPass = discount?.id;
    t.available = showPaid || coverage !== "paid";
  }

  // The snapshot IS copied: it is the fallback pool and every other search reads it,
  // so it must come out of this unchanged. Note it is not purely free trains — rows
  // advertised with a MAX seat at stops the pass doesn't cover (Bruxelles, Genève)
  // arrive `free: false`, and they still run, so a paid search has to include them.
  const snapshot: MaxTrain[] = req.free.map((t) => {
    const coverage = coverageFor(t, held, bindings);
    const discount = discountFor(t, held);
    return {
      ...t,
      coverage,
      discount: discount?.discountPercent ?? 0,
      discountPass: discount?.id,
      available: showPaid || coverage !== "paid",
    };
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
