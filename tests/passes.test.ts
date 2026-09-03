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
    expect(discountFor(db("ICE 42"), held("db-bahncard-50"))).toBe(50);
    expect(discountFor(db("ICE 42"), held("db-bahncard-25", "db-bahncard-50"))).toBe(50);
    // A discount on another operator's train is not a discount at all.
    expect(discountFor(train({ source: "ns", axe: "Intercity" }), held("db-bahncard-50"))).toBe(0);
  });
});

describe("route-bound season tickets", () => {
  const leg = (o: string, d: string) =>
    train({ source: "sncb", operator: "SNCB", axe: "IC", origin: o, destination: d });

  it("covers only the route the holder named, in both directions", () => {
    const bindings = { "sncb-train-plus": { from: "BRUXELLES MIDI", to: "GENT SINT PIETERS" } };
    const passes = held("sncb-train-plus");
    expect(coverageFor(leg("BRUXELLES MIDI", "GENT SINT PIETERS"), passes, bindings)).toBe("free");
    expect(coverageFor(leg("GENT SINT PIETERS", "BRUXELLES MIDI"), passes, bindings)).toBe("free");
    expect(coverageFor(leg("BRUXELLES MIDI", "LIEGE GUILLEMINS"), passes, bindings)).toBe("paid");
  });

  it("covers nothing until the holder names a route", () => {
    // Better to show no benefit than to invent one across the whole network.
    expect(coverageFor(leg("BRUXELLES MIDI", "GENT SINT PIETERS"), held("sncb-train-plus"), {})).toBe("paid");
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

  it("gives every discount card a percentage, and no other pass one", () => {
    for (const p of PASSES) {
      if (p.effect === "discount") expect(p.discountPercent, p.id).toBeGreaterThan(0);
      else expect(p.discountPercent, p.id).toBeUndefined();
    }
  });
});
