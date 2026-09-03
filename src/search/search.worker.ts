/// <reference lib="webworker" />
// Background search worker. Owns its own copy of the dataset (fetched from the same
// committed snapshot the page uses), runs the heavy per-search compute off the main
// thread, and posts back a cache dump the page merges so its render is a cache hit.

import type { MaxTrain, SearchQuery } from "../types";
import { loadDataset } from "../data/dataset";
import { NETWORK_PROFILES, SNCF_PROFILE, type DatasetProfile } from "../data/profile";
import { activeHubs, buildPool, datesForQuery, loadAllExtraTrains } from "../data/sources";
import { heldPasses, type RouteBinding } from "../data/passes";
import { setDefaultHubs } from "../core/connections";
import { HUB_STATIONS } from "../config";
import { clearConnCaches, dumpConnCaches, type ConnCacheDump } from "../core/connections";
import { warmForQuery } from "./warm";

interface WarmMsg {
  id: number;
  query: SearchQuery;
  today: string;
  /** Whether the page will render with paid trains included; see below. */
  includePaid?: boolean;
  /** Profile ids of the foreign networks the page has enabled. */
  networks?: string[];
  /** Subscription ids the page is judging coverage with. */
  passes?: string[];
  /** Named routes for route-bound season tickets. */
  passRoutes?: Record<string, RouteBinding>;
}

let trains: MaxTrain[] = [];
const ready: Promise<void> = loadDataset()
  .then((d) => {
    trains = d.trains;
  })
  .catch(() => {
    trains = [];
  });

// The worker's own extra shards, cached across searches exactly as the page caches its.
let extraTrains: MaxTrain[] = [];
let extraKey = "";

/**
 * The pool to warm on. It must match the page's pool: a `ConnCacheDump` is keyed by
 * route strings only, so a dump computed without paid trains would look valid to a
 * paid render and quietly answer it with free-only journeys.
 *
 * Returns null if paid trains were asked for but couldn't be loaded — the caller then
 * declines to warm at all, and the page computes on-thread with its own (correct)
 * pool, which is slower but never wrong.
 */
async function poolFor(
  query: SearchQuery,
  today: string,
  includePaid: boolean,
  networks: string[],
  passes: string[],
  passRoutes: Record<string, RouteBinding>,
): Promise<MaxTrain[] | null> {
  const sources: DatasetProfile[] = [];
  if (includePaid) sources.push(SNCF_PROFILE);
  for (const p of NETWORK_PROFILES) {
    if (networks.includes(p.id)) sources.push(p);
  }
  if (sources.length === 0) {
    setDefaultHubs(HUB_STATIONS);
    return trains;
  }
  const dates = datesForQuery(query, today);
  // The key must fold in the passes as well as the dates: they decide which trains
  // are usable, so a pool built under different passes is a different pool.
  const passKey = passes
    .map((id) => (passRoutes[id] ? `${id}:${passRoutes[id]?.from}>${passRoutes[id]?.to}` : id))
    .sort()
    .join(",");
  const key = `${sources.map((s) => s.id).join("+")}|${passKey}|${includePaid ? "paid" : "covered"}|${dates.join(",")}`;
  if (key !== extraKey) {
    const extra = await loadAllExtraTrains(sources, dates);
    // No shards at all means the page won't have them either, so warming the
    // free-only pool would misrepresent the search.
    if (extra.length === 0) return null;
    extraTrains = extra;
    extraKey = key;
  }
  // The hubs must match the page's too: they are part of every connection cache key,
  // so a mismatch would make the dump useless at best and wrong at worst.
  setDefaultHubs(activeHubs(HUB_STATIONS));
  return buildPool({
    free: trains,
    extra: extraTrains,
    held: heldPasses(passes),
    bindings: passRoutes,
    showPaid: includePaid,
    key,
  });
}

const ctx = self as unknown as {
  postMessage: (m: { id: number; dump: ConnCacheDump | null }) => void;
  onmessage: ((e: MessageEvent<WarmMsg>) => void) | null;
};

ctx.onmessage = (e: MessageEvent<WarmMsg>): void => {
  const { id, query, today, includePaid, networks, passes, passRoutes } = e.data;
  void ready
    .then(async () => {
      if (!trains.length) {
        ctx.postMessage({ id, dump: null });
        return;
      }
      const pool = await poolFor(query, today, includePaid === true, networks ?? [], passes ?? [], passRoutes ?? {});
      if (!pool) {
        ctx.postMessage({ id, dump: null });
        return;
      }
      // Clear first so the dump carries only THIS search's working set, not everything
      // computed since the worker started.
      clearConnCaches(pool);
      warmForQuery(pool, query, today);
      ctx.postMessage({ id, dump: dumpConnCaches(pool) });
    })
    .catch(() => {
      ctx.postMessage({ id, dump: null });
    });
};
