/// <reference lib="webworker" />
// Background search worker. Owns its own copy of the dataset (fetched from the same
// committed snapshot the page uses), runs the heavy per-search compute off the main
// thread, and posts back a cache dump the page merges so its render is a cache hit.

import type { MaxTrain, SearchQuery } from "../types";
import { loadDataset } from "../data/dataset";
import { SNCF_PROFILE } from "../data/profile";
import { datesForQuery, loadExtraTrains, searchPool } from "../data/sources";
import { clearConnCaches, dumpConnCaches, type ConnCacheDump } from "../core/connections";
import { warmForQuery } from "./warm";

interface WarmMsg {
  id: number;
  query: SearchQuery;
  today: string;
  /** Whether the page will render with paid trains included; see below. */
  includePaid?: boolean;
}

let trains: MaxTrain[] = [];
const ready: Promise<void> = loadDataset()
  .then((d) => {
    trains = d.trains;
  })
  .catch(() => {
    trains = [];
  });

// The worker's own paid shards, cached across searches exactly as the page caches its.
let paidExtra: MaxTrain[] = [];
let paidWindowKey = "";

/**
 * The pool to warm on. It must match the page's pool: a `ConnCacheDump` is keyed by
 * route strings only, so a dump computed without paid trains would look valid to a
 * paid render and quietly answer it with free-only journeys.
 *
 * Returns null if paid trains were asked for but couldn't be loaded — the caller then
 * declines to warm at all, and the page computes on-thread with its own (correct)
 * pool, which is slower but never wrong.
 */
async function poolFor(query: SearchQuery, today: string, includePaid: boolean): Promise<MaxTrain[] | null> {
  if (!includePaid) return trains;
  const dates = datesForQuery(query, today);
  const key = dates.join(",");
  if (key !== paidWindowKey) {
    const extra = await loadExtraTrains(SNCF_PROFILE, dates);
    // No shards at all means the page won't have them either, so warming the
    // free-only pool would misrepresent a paid search.
    if (extra.length === 0) return null;
    paidExtra = extra;
    paidWindowKey = key;
  }
  return searchPool(trains, paidExtra, key);
}

const ctx = self as unknown as {
  postMessage: (m: { id: number; dump: ConnCacheDump | null }) => void;
  onmessage: ((e: MessageEvent<WarmMsg>) => void) | null;
};

ctx.onmessage = (e: MessageEvent<WarmMsg>): void => {
  const { id, query, today, includePaid } = e.data;
  void ready
    .then(async () => {
      if (!trains.length) {
        ctx.postMessage({ id, dump: null });
        return;
      }
      const pool = await poolFor(query, today, includePaid === true);
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
