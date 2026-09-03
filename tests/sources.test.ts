import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MaxTrain, SearchQuery } from "../src/types";
import { encodeShard, decodeShard, SHARD_VERSION, type EncodableTrain } from "../src/data/shard";
import {
  stationsForQuery,
  calendarDates,
  loadStationTrains,
  buildPool,
  resetSources,
  BOOKING_WINDOW_DAYS,
} from "../src/data/sources";
import { stationFileName } from "../src/data/stationShard";
import { heldPasses } from "../src/data/passes";
import type { DatasetProfile } from "../src/data/profile";
import { filterTrains } from "../src/core/search";
import { findJourneys } from "../src/core/connections";

const D = "2026-07-01";
const rows: EncodableTrain[] = [
  { date: D, origin: "ALPHA", destination: "BETA", departMin: 480, arriveMin: 600, trainNo: "1", category: "ICE" },
  { date: D, origin: "BETA", destination: "GAMMA", departMin: 700, arriveMin: 800, trainNo: "2" },
  // Crosses midnight: the encoder is handed an already-absolute arrival.
  { date: D, origin: "ALPHA", destination: "GAMMA", departMin: 1380, arriveMin: 1490, trainNo: "3", category: "ICE" },
];

const META = { source: "demo", operator: "DEMO", free: false };

describe("shard codec", () => {
  it("round-trips trains through the compact format", () => {
    const decoded = decodeShard(encodeShard(rows, META));
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
    const shard = encodeShard(rows, META);
    // 3 distinct stations across 3 trains, and 1 distinct category across 2 uses.
    expect(shard.stations).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(shard.categories).toEqual(["ICE"]);
    // The category-less train records -1 rather than an index.
    expect(shard.rows[1]?.[5]).toBe(-1);
    expect(decodeShard(shard)[1]?.axe).toBeUndefined();
  });

  it("keeps a past-midnight arrival absolute, so duration stays positive", () => {
    const overnight = decodeShard(encodeShard(rows, META))[2];
    expect(overnight?.arriveMin).toBe(1490);
    expect(overnight?.arrive).toBe("00:50");
    expect(overnight?.durationMin).toBe(110);
  });

  it("marks shard trains as paid, not free", () => {
    const [train] = decodeShard(encodeShard(rows, META));
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
    const bad = { ...encodeShard(rows, META), rows: [[99, 0, 1, 2, "x", -1]] };
    expect(decodeShard(bad)).toEqual([]);
  });
});

describe("stationsForQuery", () => {
  const base: SearchQuery = { mode: "od", date: "2026-07-01", card: "jeune", maxConnections: 1 };

  it("names the stations a search mentions — the shards it needs", () => {
    // The whole economy of the design: a search fetches the places it names, not a
    // day of every train in a country.
    const ids = stationsForQuery({ ...base, origin: "A", destination: "B", via: "H" });
    expect(new Set(ids)).toEqual(new Set(["A", "B", "H"]));
  });

  it("covers tour cities and every multi-city leg endpoint", () => {
    const ids = stationsForQuery({
      ...base,
      mode: "tour",
      origin: "A",
      cities: ["C1", "C2"],
      legs: [{ from: "L1", to: "L2", date: "2026-07-04" }],
    });
    for (const id of ["A", "C1", "C2", "L1", "L2"]) expect(ids).toContain(id);
  });

  it("returns nothing for a query with no stations yet", () => {
    expect(stationsForQuery(base)).toEqual([]);
  });
});

describe("calendarDates", () => {
  it("is the whole booking window — what the calendars sweep", () => {
    const dates = calendarDates("2026-07-01");
    expect(dates).toHaveLength(BOOKING_WINDOW_DAYS);
    expect(dates[0]).toBe("2026-07-01");
    expect(dates[BOOKING_WINDOW_DAYS - 1]).toBe("2026-07-30");
  });
});

describe("buildPool", () => {
  const free: MaxTrain[] = [];
  const extra = decodeShard(encodeShard(rows, META));
  const pool = (over: Partial<Parameters<typeof buildPool>[0]> = {}) =>
    buildPool({
      free,
      extra,
      held: heldPasses(["sncf-max-jeune"]),
      bindings: {},
      showPaid: true,
      key: "k",
      ...over,
    });

  beforeEach(resetSources);

  it("reuses one array identity for the same key, so caches survive a re-search", () => {
    const a = pool({ key: "window-a" });
    const b = pool({ key: "window-a" });
    expect(b).toBe(a);
  });

  it("builds a fresh array when the key changes, so a stale pool is never reused", () => {
    const a = pool({ key: "window-a" });
    const b = pool({ key: "window-b" });
    expect(b).not.toBe(a);
  });

  it("hides trains no held pass covers unless paid trains were asked for", () => {
    // The extras here are a demo source no pass mentions, so they are all "paid".
    const covered = pool({ key: "covered", showPaid: false });
    expect(covered.every((t) => !t.available)).toBe(true);
    const shown = pool({ key: "shown", showPaid: true });
    expect(shown.every((t) => t.available)).toBe(true);
    expect(shown.every((t) => t.coverage === "paid")).toBe(true);
  });

  it("surfaces snapshot trains the pass excludes, since they still run", () => {
    // Genève/Bruxelles rows are advertised with a MAX seat but aren't bookable with
    // the pass, so the snapshot carries them as unavailable. A paid search must still
    // show them — otherwise the route lists every train EXCEPT those.
    const excluded: MaxTrain = {
      date: "2026-07-01",
      origin: "PARIS (intramuros)",
      destination: "GENEVE",
      depart: "08:00",
      arrive: "11:00",
      departMin: 480,
      arriveMin: 660,
      durationMin: 180,
      trainNo: "9764",
      available: false,
      free: false,
      paid: true,
    };
    const built = pool({ free: [excluded], key: "window-c", showPaid: true });
    const geneva = built.find((t: MaxTrain) => t.destination === "GENEVE");
    expect(geneva?.available).toBe(true);
    expect(geneva?.coverage).toBe("paid");
    // The snapshot itself is never mutated — it stays the fallback pool.
    expect(excluded.available).toBe(false);
  });
});

describe("paid trains in the core search", () => {
  // The whole design rests on this: the core has no idea what "paid" means, it only
  // reads `available`. So marking shard trains usable must make them searchable
  // through every existing code path, with no paid-aware branch anywhere.
  const paidPool: MaxTrain[] = decodeShard(encodeShard(rows, META)).map((t) => ({
    ...t,
    available: true,
  }));

  it("excludes paid trains while they are not marked usable", () => {
    const unusable = decodeShard(encodeShard(rows, META));
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

describe("loadStationTrains", () => {
  const profile = { id: "demo", shardDir: "/data/demo/" } as DatasetProfile;
  const originalFetch = globalThis.fetch;

  beforeEach(resetSources);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Serve an index plus station shards from a map of url → body. */
  function serve(bodies: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const key = String(url);
      if (!(key in bodies)) return { ok: false, status: 404 } as Response;
      return { ok: true, json: async () => bodies[key] } as Response;
    }) as unknown as typeof fetch;
  }

  const url = (id: string) => `/data/demo/s/${stationFileName(id)}`;

  it("fetches a station's shard and marks its trains usable", async () => {
    serve({
      "/data/demo/index.json": { v: 2, hubs: ["BETA"], counts: { ALPHA: 3 } },
      [url("ALPHA")]: encodeShard(rows, META),
    });
    const extra = await loadStationTrains(profile, ["ALPHA"]);
    expect(extra).toHaveLength(3);
    expect(extra.every((t) => t.available)).toBe(true);
    expect(extra.every((t) => t.paid)).toBe(true);
  });

  it("does not request a station the index says it has nothing for", async () => {
    serve({ "/data/demo/index.json": { v: 2, counts: { ALPHA: 3 } } });
    await loadStationTrains(profile, ["NOWHERE"]);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls).not.toContain(url("NOWHERE"));
  });

  it("removes the duplicates that filing a leg under both endpoints creates", async () => {
    // A leg lives in its origin's shard AND its destination's. Fetching both must not
    // offer the same train twice.
    serve({
      "/data/demo/index.json": { v: 2, counts: { ALPHA: 3, BETA: 2 } },
      [url("ALPHA")]: encodeShard(rows, META),
      [url("BETA")]: encodeShard(rows.slice(0, 2), META),
    });
    const extra = await loadStationTrains(profile, ["ALPHA", "BETA"]);
    expect(extra).toHaveLength(3);
    expect(new Set(extra.map((t) => t.trainNo)).size).toBe(3);
  });

  it("caches a station, so a second search does not refetch it", async () => {
    serve({
      "/data/demo/index.json": { v: 2, counts: { ALPHA: 3 } },
      [url("ALPHA")]: encodeShard(rows, META),
    });
    await loadStationTrains(profile, ["ALPHA"]);
    await loadStationTrains(profile, ["ALPHA"]);
    const shardCalls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u === url("ALPHA"));
    expect(shardCalls).toHaveLength(1);
  });

  it("degrades to no extra trains when the index is missing", async () => {
    serve({});
    await expect(loadStationTrains(profile, ["ALPHA"])).resolves.toEqual([]);
  });

  it("degrades to no extra trains for a source with no shard directory", async () => {
    serve({});
    await expect(loadStationTrains({ id: "none" } as DatasetProfile, ["ALPHA"])).resolves.toEqual([]);
  });
});

describe("stationFileName", () => {
  it("is stable, and safe as a file name", () => {
    expect(stationFileName("PARIS (intramuros)")).toBe(stationFileName("PARIS (intramuros)"));
    expect(stationFileName("PARIS (intramuros)")).toMatch(/^[a-z0-9-]+\.json$/);
  });

  it("separates stations whose slugs would collide", () => {
    // Accents and punctuation fold away, so identity has to come from the hash —
    // otherwise one station's trains would be served for another.
    expect(stationFileName("LIEGE GUILLEMINS")).not.toBe(stationFileName("LIÈGE-GUILLEMINS"));
    expect(stationFileName("A".repeat(60) + "1")).not.toBe(stationFileName("A".repeat(60) + "2"));
  });
});
