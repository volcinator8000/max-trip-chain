import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MaxTrain, SearchQuery } from "../src/types";
import { encodeShard, decodeShard, SHARD_VERSION, type EncodableTrain } from "../src/data/shard";
import { datesForQuery, loadExtraTrains, searchPool, resetSources, BOOKING_WINDOW_DAYS } from "../src/data/sources";
import type { DatasetProfile } from "../src/data/profile";
import { filterTrains } from "../src/core/search";
import { findJourneys } from "../src/core/connections";

const rows: EncodableTrain[] = [
  { origin: "ALPHA", destination: "BETA", departMin: 480, arriveMin: 600, trainNo: "1", category: "ICE" },
  { origin: "BETA", destination: "GAMMA", departMin: 700, arriveMin: 800, trainNo: "2" },
  // Crosses midnight: the encoder is handed an already-absolute arrival.
  { origin: "ALPHA", destination: "GAMMA", departMin: 1380, arriveMin: 1490, trainNo: "3", category: "ICE" },
];

const META = { source: "demo", operator: "DEMO", free: false };

describe("shard codec", () => {
  it("round-trips trains through the compact format", () => {
    const decoded = decodeShard(encodeShard("2026-07-01", rows, META));
    expect(decoded).toHaveLength(3);
    const [first] = decoded;
    expect(first).toMatchObject({
      date: "2026-07-01",
      origin: "ALPHA",
      destination: "BETA",
      depart: "08:00",
      arrive: "10:00",
      durationMin: 120,
      trainNo: "1",
      axe: "ICE",
      source: "demo",
      operator: "DEMO",
    });
  });

  it("interns repeated station and category names into string tables", () => {
    const shard = encodeShard("2026-07-01", rows, META);
    // 3 distinct stations across 3 trains, and 1 distinct category across 2 uses.
    expect(shard.stations).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(shard.categories).toEqual(["ICE"]);
    // The category-less train records -1 rather than an index.
    expect(shard.rows[1]?.[5]).toBe(-1);
    expect(decodeShard(shard)[1]?.axe).toBeUndefined();
  });

  it("keeps a past-midnight arrival absolute, so duration stays positive", () => {
    const overnight = decodeShard(encodeShard("2026-07-01", rows, META))[2];
    expect(overnight?.arriveMin).toBe(1490);
    expect(overnight?.arrive).toBe("00:50");
    expect(overnight?.durationMin).toBe(110);
  });

  it("marks shard trains as paid, not free", () => {
    const [train] = decodeShard(encodeShard("2026-07-01", rows, META));
    expect(train?.free).toBe(false);
    expect(train?.paid).toBe(true);
    // The codec does NOT decide usability — the loader does, once the user opts in.
    expect(train?.available).toBe(false);
  });

  it("returns nothing for a malformed or future-versioned shard rather than throwing", () => {
    expect(decodeShard(null)).toEqual([]);
    expect(decodeShard({ v: SHARD_VERSION + 1, date: "2026-07-01", rows: [], stations: [] })).toEqual([]);
    expect(decodeShard({ v: SHARD_VERSION, date: "2026-07-01" })).toEqual([]);
    // A row pointing outside the string table is skipped, not fatal.
    const bad = { ...encodeShard("2026-07-01", rows, META), rows: [[99, 0, 1, 2, "x", -1]] };
    expect(decodeShard(bad)).toEqual([]);
  });
});

describe("datesForQuery", () => {
  const base: SearchQuery = { mode: "od", date: "2026-07-01", card: "jeune", maxConnections: 1 };

  it("covers the whole booking window, because every mode draws a 30-day calendar", () => {
    const dates = datesForQuery(base, "2026-07-01");
    expect(dates).toHaveLength(BOOKING_WINDOW_DAYS);
    expect(dates[0]).toBe("2026-07-01");
    expect(dates[BOOKING_WINDOW_DAYS - 1]).toBe("2026-07-30");
  });

  it("adds chosen days that fall outside the window, and never duplicates", () => {
    const dates = datesForQuery(
      { ...base, date: "2026-06-20", returnDate: "2026-07-05", tourEndDate: "2026-09-01" },
      "2026-07-01",
    );
    expect(dates).toContain("2026-06-20"); // before the window
    expect(dates).toContain("2026-09-01"); // beyond it
    expect(dates).toContain("2026-07-05"); // inside — must not appear twice
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates); // ascending
  });

  it("includes each multi-city leg's date", () => {
    const dates = datesForQuery(
      { ...base, mode: "tour", legs: [{ from: "A", to: "B", date: "2026-08-20" }] },
      "2026-07-01",
    );
    expect(dates).toContain("2026-08-20");
  });
});

describe("searchPool", () => {
  const free: MaxTrain[] = [];
  const extra = decodeShard(encodeShard("2026-07-01", rows, META));

  beforeEach(resetSources);

  it("returns the free array itself when there is nothing extra", () => {
    // Identity matters: the core memoizes on the trains array, so the default path
    // must keep the very same array and its warm caches.
    expect(searchPool(free, [], "k")).toBe(free);
  });

  it("reuses one array identity for the same key, so caches survive a re-search", () => {
    const a = searchPool(free, extra, "window-a");
    const b = searchPool(free, extra, "window-a");
    expect(b).toBe(a);
  });

  it("builds a fresh array when the key changes, so a stale pool is never reused", () => {
    const a = searchPool(free, extra, "window-a");
    const b = searchPool(free, extra, "window-b");
    expect(b).not.toBe(a);
  });
});

describe("paid trains in the core search", () => {
  // The whole design rests on this: the core has no idea what "paid" means, it only
  // reads `available`. So marking shard trains usable must make them searchable
  // through every existing code path, with no paid-aware branch anywhere.
  const paidPool: MaxTrain[] = decodeShard(encodeShard("2026-07-01", rows, META)).map((t) => ({
    ...t,
    available: true,
  }));

  it("excludes paid trains while they are not marked usable", () => {
    const unusable = decodeShard(encodeShard("2026-07-01", rows, META));
    expect(filterTrains(unusable, { origin: "ALPHA" })).toHaveLength(0);
  });

  it("includes them once the pool marks them usable", () => {
    const found = filterTrains(paidPool, { origin: "ALPHA", destination: "BETA" });
    expect(found).toHaveLength(1);
    expect(found[0]?.paid).toBe(true);
  });

  it("lets the connection engine build a paid journey with a change", () => {
    // BETA must be declared a hub: the engine only changes at hubs, which is exactly
    // the knob each network's profile supplies for its own interchanges.
    const journeys = findJourneys(paidPool, "ALPHA", "GAMMA", "2026-07-01", {
      maxConnections: 1,
      hubs: ["BETA"],
    });
    const viaBeta = journeys.find((j) => j.legs.length === 2);
    expect(viaBeta?.hubs).toEqual(["BETA"]);
    expect(viaBeta?.legs.every((l) => l.paid)).toBe(true);
  });
});

describe("loadExtraTrains", () => {
  const profile = { id: "demo", shardDir: "/data/demo/" } as DatasetProfile;
  const originalFetch = globalThis.fetch;

  beforeEach(resetSources);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Serve an index plus shards from a map of url → body. */
  function serve(bodies: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const key = String(url);
      if (!(key in bodies)) return { ok: false, status: 404 } as Response;
      return { ok: true, json: async () => bodies[key] } as Response;
    }) as unknown as typeof fetch;
  }

  it("fetches only the days the index says exist, and marks them usable", async () => {
    serve({
      "/data/demo/index.json": { v: 1, days: [{ date: "2026-07-01", count: 3 }] },
      "/data/demo/2026-07-01.json": encodeShard("2026-07-01", rows, META),
    });
    const extra = await loadExtraTrains(profile, ["2026-07-01", "2026-07-02"]);
    expect(extra).toHaveLength(3);
    expect(extra.every((t) => t.available)).toBe(true);
    expect(extra.every((t) => t.paid)).toBe(true);
    // 2026-07-02 is absent from the index, so it must not have been requested.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls).not.toContain("/data/demo/2026-07-02.json");
  });

  it("caches a day, so a second search does not refetch it", async () => {
    serve({
      "/data/demo/index.json": { v: 1, days: [{ date: "2026-07-01", count: 3 }] },
      "/data/demo/2026-07-01.json": encodeShard("2026-07-01", rows, META),
    });
    await loadExtraTrains(profile, ["2026-07-01"]);
    await loadExtraTrains(profile, ["2026-07-01"]);
    const shardCalls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.endsWith("2026-07-01.json"));
    expect(shardCalls).toHaveLength(1);
  });

  it("degrades to no extra trains when the index is missing", async () => {
    serve({});
    await expect(loadExtraTrains(profile, ["2026-07-01"])).resolves.toEqual([]);
  });

  it("degrades to no extra trains for a source with no shard directory", async () => {
    serve({});
    await expect(loadExtraTrains({ id: "none" } as DatasetProfile, ["2026-07-01"])).resolves.toEqual([]);
  });
});
