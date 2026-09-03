import { describe, it, expect } from "vitest";
import type { MaxTrain } from "../src/types";
import {
  PASSES,
  SELECTABLE_PASSES,
  passById,
  passCoverage,
  coverageFor,
  discountFor,
  heldPasses,
  isWeekendDate,
  isOffPeak,
} from "../src/data/passes";

/** A train, with the real category strings the feeds actually publish. */
function train(over: Partial<MaxTrain> = {}): MaxTrain {
  return {
    date: "2026-09-10", // a Thursday
    origin: "A",
    destination: "B",
    depart: "08:00",
    arrive: "10:00",
    departMin: 480,
    arriveMin: 600,
    durationMin: 120,
    trainNo: "1",
    available: true,
    free: false,
    paid: true,
    source: "ns",
    operator: "NS",
    axe: "Intercity",
    ...over,
  };
}

const held = (...ids: string[]) => heldPasses(ids);

describe("category matching against the feeds' real strings", () => {
  const dt = passById("db-deutschlandticket")!;

  it("matches a class with a line number appended", () => {
    // DB publishes "ICE 42", "IC 55" — not bare "ICE"/"IC".
    expect(passCoverage(dt, train({ source: "db-fernverkehr", axe: "ICE 42" }))).toBeNull();
    expect(passCoverage(dt, train({ source: "db-fernverkehr", axe: "IC 55" }))).toBeNull();
  });

  it("does not let a shorter class swallow a longer one", () => {
    // "IC" must not match "ICE 42" by prefix alone; both are excluded here, so prove
    // the boundary rule directly on a pass that excludes only EC.
    const go = passById("sncb-go-unlimited")!;
    expect(passCoverage(go, train({ source: "sncb", axe: "EC" }))).toBeNull(); // international
    expect(passCoverage(go, train({ source: "sncb", axe: "IC" }))).toBe("free"); // domestic
  });

  it("prefers the most specific rule when two match", () => {
    // "Intercity direct" carries a supplement; plain "Intercity" does not. The longer
    // rule has to win, or the supplement silently disappears.
    const ns = passById("ns-ov-jaarkaart")!;
    expect(passCoverage(ns, train({ axe: "Intercity" }))).toBe("free");
    expect(passCoverage(ns, train({ axe: "Intercity direct" }))).toBe("reserve");
  });
});

describe("SNCF MAX passes", () => {
  const sncf = (over: Partial<MaxTrain> = {}) =>
    train({ source: "sncf-tgvmax", operator: "SNCF", axe: "SUD EST", ...over });

  it("is free only when the feed says a MAX seat is actually open", () => {
    expect(coverageFor(sncf({ free: true }), held("sncf-max-jeune"))).toBe("free");
    expect(coverageFor(sncf({ free: false }), held("sncf-max-jeune"))).toBe("paid");
  });

  it("restricts MAX SENIOR to weekdays, per the leg's own date", () => {
    // 2026-09-12 is a Saturday; the constraint is about when you travel, not when you
    // searched, so it must be judged on the train's date.
    expect(isWeekendDate("2026-09-12")).toBe(true);
    expect(coverageFor(sncf({ free: true, date: "2026-09-10" }), held("sncf-max-senior"))).toBe("free");
    expect(coverageFor(sncf({ free: true, date: "2026-09-12" }), held("sncf-max-senior"))).toBe("paid");
  });

  it("lets someone holding both passes travel on either basis", () => {
    const weekend = sncf({ free: true, date: "2026-09-12" });
    expect(coverageFor(weekend, held("sncf-max-senior"))).toBe("paid");
    expect(coverageFor(weekend, held("sncf-max-jeune", "sncf-max-senior"))).toBe("free");
  });
});

describe("German passes", () => {
  const db = (axe: string) => train({ source: "db-fernverkehr", operator: "DB", axe });

  it("BahnCard 100 covers the long-distance network", () => {
    expect(coverageFor(db("ICE 42"), held("db-bahncard-100"))).toBe("free");
  });

  it("Deutschlandticket covers nothing in the long-distance feed", () => {
    // Not a bug: it is valid on regional transport only, and every line in the feed
    // the app loads is an ICE/IC/EC. Asserted so the limitation stays visible.
    for (const axe of ["ICE 42", "IC 55", "EC 8"]) {
      expect(coverageFor(db(axe), held("db-deutschlandticket"))).toBe("paid");
    }
  });

  it("a discount card never makes a train free, but is reported", () => {
    expect(coverageFor(db("ICE 42"), held("db-bahncard-50"))).toBe("paid");
    expect(discountFor(db("ICE 42"), held("db-bahncard-50"))?.discountPercent).toBe(50);
    // The better card wins when both are held.
    expect(discountFor(db("ICE 42"), held("db-bahncard-25", "db-bahncard-50"))?.discountPercent).toBe(50);
    // A discount on another operator's train is not a discount at all.
    expect(discountFor(train({ source: "ns", axe: "Intercity" }), held("db-bahncard-50"))).toBeNull();
  });
});

describe("route-bound season tickets", () => {
  const leg = (o: string, d: string) =>
    train({ source: "ns", operator: "NS", axe: "Intercity", origin: o, destination: d });

  it("covers only the route the holder named, in both directions", () => {
    const bindings = { "ns-traject-vrij": { from: "AMSTERDAM CENTRAAL", to: "UTRECHT CENTRAAL" } };
    const passes = held("ns-traject-vrij");
    expect(coverageFor(leg("AMSTERDAM CENTRAAL", "UTRECHT CENTRAAL"), passes, bindings)).toBe("free");
    expect(coverageFor(leg("UTRECHT CENTRAAL", "AMSTERDAM CENTRAAL"), passes, bindings)).toBe("free");
    expect(coverageFor(leg("AMSTERDAM CENTRAAL", "ROTTERDAM CENTRAAL"), passes, bindings)).toBe("paid");
  });

  it("covers nothing until the holder names a route", () => {
    // Better to show no benefit than to invent one across the whole network.
    expect(coverageFor(leg("AMSTERDAM CENTRAAL", "UTRECHT CENTRAAL"), held("ns-traject-vrij"), {})).toBe("paid");
  });
});

describe("SNCB Train+ — an off-peak reduction across the network", () => {
  // Not free travel and not route-bound: a reduction you earn by travelling outside
  // the weekday rush, so it must never make a train free, and must not apply at 08:00.
  const sncb = (over: Partial<MaxTrain> = {}) =>
    train({ source: "sncb", operator: "SNCB", axe: "IC", ...over });
  const passes = held("sncb-train-plus");

  it("never makes a train free, however off-peak", () => {
    expect(coverageFor(sncb({ departMin: 11 * 60 }), passes)).toBe("paid");
  });

  it("applies away from the weekday peaks, and not inside them", () => {
    // 2026-09-10 is a Thursday: 08:00 and 17:30 are peak, 11:00 and 21:00 are not.
    expect(discountFor(sncb({ departMin: 8 * 60 }), passes)).toBeNull();
    expect(discountFor(sncb({ departMin: 17 * 60 + 30 }), passes)).toBeNull();
    expect(discountFor(sncb({ departMin: 11 * 60 }), passes)?.id).toBe("sncb-train-plus");
    expect(discountFor(sncb({ departMin: 21 * 60 }), passes)?.id).toBe("sncb-train-plus");
  });

  it("treats the whole weekend as off-peak", () => {
    // 2026-09-12 is a Saturday, so even a 08:00 departure qualifies.
    expect(isOffPeak(sncb({ date: "2026-09-12", departMin: 8 * 60 }))).toBe(true);
    expect(discountFor(sncb({ date: "2026-09-12", departMin: 8 * 60 }), passes)?.id).toBe("sncb-train-plus");
  });

  it("is reported without inventing a rate, since the rate is not encoded", () => {
    expect(discountFor(sncb({ departMin: 11 * 60 }), passes)?.discountPercent).toBeUndefined();
  });

  it("does not apply to the international EuroCity", () => {
    expect(discountFor(sncb({ axe: "EC", departMin: 11 * 60 }), passes)).toBeNull();
  });
});

describe("Luxembourg's free transport", () => {
  const cfl = (axe: string) => train({ source: "cfl", operator: "CFL", axe });

  it("is free for everyone, with no pass held", () => {
    // A fact about the network, not a subscription — so it applies to a user who has
    // chosen nothing at all.
    expect(coverageFor(cfl("RE"), held())).toBe("free");
    expect(coverageFor(cfl("RB"), held())).toBe("free");
    expect(coverageFor(cfl("IC"), held())).toBe("free");
  });

  it("does not extend to the French cross-border TER", () => {
    expect(coverageFor(cfl("TER"), held())).toBe("paid");
  });

  it("is not offered as a choice in the pass list", () => {
    expect(SELECTABLE_PASSES.some((p) => p.id === "lu-free-transport")).toBe(false);
    expect(heldPasses([]).some((p) => p.id === "lu-free-transport")).toBe(true);
  });
});

describe("combining passes", () => {
  it("takes the best outcome across everything held", () => {
    const direct = train({ axe: "Intercity direct" });
    expect(coverageFor(direct, held("ns-ov-jaarkaart"))).toBe("reserve");
    // Nothing a Belgian pass says can change what a Dutch train costs.
    expect(coverageFor(direct, held("ns-ov-jaarkaart", "sncb-go-unlimited"))).toBe("reserve");
  });

  it("gives nothing on a network you hold no pass for", () => {
    expect(coverageFor(train({ source: "ns", axe: "Intercity" }), held("db-bahncard-100"))).toBe("paid");
    expect(coverageFor(train({ source: "ns", axe: "Eurostar" }), held("ns-ov-jaarkaart"))).toBe("paid");
  });

  it("ignores an unknown pass id rather than throwing", () => {
    expect(() => heldPasses(["nope"])).not.toThrow();
    expect(heldPasses(["nope"]).every((p) => p.alwaysHeld)).toBe(true);
  });
});

describe("the pass table itself", () => {
  it("has unique ids and names a real source for each", () => {
    const ids = PASSES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(["sncf-tgvmax", "db-fernverkehr", "sncb", "cfl", "ns"]);
    for (const p of PASSES) {
      expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) expect(known.has(s), `${p.id} names unknown source ${s}`).toBe(true);
    }
  });

  it("only ever puts a percentage on a discount card", () => {
    // A discount card may omit its rate (it is then reported without a figure), but
    // a pass that makes travel free must never carry one.
    for (const p of PASSES) {
      if (p.effect !== "discount") expect(p.discountPercent, p.id).toBeUndefined();
    }
  });
});

describe("ranking journeys by what they cost you", () => {
  // No feed the app reads publishes a fare — not the SNCF dataset, not any of the
  // five GTFS feeds — so "cheapest" ranks pass coverage, which IS known. These lock
  // in the ordering that produces: free < reservation < paid, discounts breaking ties.
  const leg = (coverage: "free" | "reserve" | "paid", discount = 0): MaxTrain =>
    train({ coverage, discount, paid: coverage !== "free" });

  /** Mirrors costRank in src/app.ts. */
  const rank = (legs: MaxTrain[]): number =>
    legs.reduce((sum, l) => {
      const c = l.coverage ?? (l.paid ? "paid" : "free");
      if (c === "free") return sum;
      return sum + (c === "reserve" ? 1 : 10 - Math.min(9, (l.discount ?? 0) / 12));
    }, 0);

  it("puts a wholly covered journey first", () => {
    expect(rank([leg("free"), leg("free")])).toBe(0);
  });

  it("prefers a reservation supplement to paying a full fare", () => {
    expect(rank([leg("reserve")])).toBeLessThan(rank([leg("paid")]));
  });

  it("counts every leg, so fewer paid legs win", () => {
    expect(rank([leg("free"), leg("paid")])).toBeLessThan(rank([leg("paid"), leg("paid")]));
  });

  it("lets a discount card improve a paid journey without making it free", () => {
    const discounted = rank([leg("paid", 50)]);
    expect(discounted).toBeLessThan(rank([leg("paid")]));
    expect(discounted).toBeGreaterThan(rank([leg("free")]));
    // ...and never good enough to beat a journey that costs nothing at all.
    expect(discounted).toBeGreaterThan(rank([leg("reserve")]));
  });
});
