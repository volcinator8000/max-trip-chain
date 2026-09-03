import { describe, it, expect } from "vitest";
import {
  parseGtfsTime,
  splitCsvLine,
  normalizeStationName,
  canonicalStationId,
  buildCrosswalk,
} from "../src/data/gtfs";
import { parseTimeToMinutes } from "../src/util/time";
import crosswalkJson from "../data/crosswalk.json";

describe("parseGtfsTime", () => {
  it("parses ordinary times", () => {
    expect(parseGtfsTime("08:00:00")).toBe(480);
    expect(parseGtfsTime("08:00")).toBe(480);
    expect(parseGtfsTime(" 23:59:00 ")).toBe(1439);
  });

  it("keeps GTFS hours past 24, which the app's own parser rejects", () => {
    // This is the whole reason for a separate parser: GTFS expresses a trip running
    // past midnight as 25:30, and the app parser treats h > 23 as malformed. Losing
    // these would silently drop every night train from a foreign feed.
    expect(parseTimeToMinutes("25:30")).toBeNaN();
    expect(parseGtfsTime("25:30:00")).toBe(25 * 60 + 30);
    expect(parseGtfsTime("24:05:00")).toBe(24 * 60 + 5);
  });

  it("rejects malformed values rather than guessing", () => {
    expect(parseGtfsTime("")).toBeNaN();
    expect(parseGtfsTime("8h00")).toBeNaN();
    expect(parseGtfsTime("12:60:00")).toBeNaN();
  });
});

describe("splitCsvLine", () => {
  it("splits plain rows", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
    expect(splitCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });

  it("keeps commas inside quoted fields — station names contain them", () => {
    expect(splitCsvLine('1,"Hamburg, Hamburg Hbf",3')).toEqual(["1", "Hamburg, Hamburg Hbf", "3"]);
  });

  it("unescapes doubled quotes", () => {
    expect(splitCsvLine('1,"He said ""hi""",3')).toEqual(["1", 'He said "hi"', "3"]);
  });
});

describe("normalizeStationName", () => {
  it("folds accents, punctuation and country tags", () => {
    expect(normalizeStationName("Köln Hbf")).toBe("koln hbf");
    expect(normalizeStationName("Köln Hbf (DE)")).toBe("koln hbf");
    expect(normalizeStationName("Liège-Guillemins")).toBe("liege guillemins");
  });

  it("treats Hbf and Hauptbahnhof as the same station", () => {
    // DB ships both spellings for one station, across its platform and parent rows.
    expect(normalizeStationName("Frankfurt (Main) Hauptbahnhof")).toBe(
      normalizeStationName("Frankfurt(Main)Hbf"),
    );
  });

  it("drops a regional-transport mode prefix and a repeated city", () => {
    expect(normalizeStationName("S+U Berlin Hauptbahnhof")).toBe("berlin hbf");
    expect(normalizeStationName("Hamburg, Hamburg Hbf")).toBe("hamburg hbf");
  });
});

describe("canonicalStationId with the shipped crosswalk", () => {
  const cw = buildCrosswalk(crosswalkJson as Record<string, unknown>);

  it("resolves each feed's name for a shared interchange onto ONE id", () => {
    // The point of the whole exercise: a cross-border journey only exists if both
    // halves land on the same node. These are the real spellings in the four feeds.
    const paris = ["Paris Est", "Paris Nord", "Paris Nord (FR)", "Paris-Est"];
    for (const name of paris) expect(canonicalStationId(name, cw)).toBe("PARIS (intramuros)");

    const brussels = ["Bruxelles Midi", "Bruxelles-Midi", "Brussel-Zuid"];
    for (const name of brussels) expect(canonicalStationId(name, cw)).toBe("BRUXELLES MIDI");

    const amsterdam = ["Amsterdam Centraal", "Amsterdam Cs (NL)"];
    for (const name of amsterdam) expect(canonicalStationId(name, cw)).toBe("AMSTERDAM CENTRAAL");
  });

  it("uses the SNCF spelling as canonical, so the French half of a join matches", () => {
    // SNCF publishes "FRANKFURT AM MAIN HBF"; DB publishes "Frankfurt(Main)Hbf". The
    // canonical id must be SNCF's, because the SNCF rows are not rewritten.
    expect(canonicalStationId("Frankfurt(Main)Hbf", cw)).toBe("FRANKFURT AM MAIN HBF");
    expect(canonicalStationId("FRANKFURT AM MAIN HBF", cw)).toBe("FRANKFURT AM MAIN HBF");
    expect(canonicalStationId("Luxembourg, Gare Centrale", cw)).toBe("LUXEMBOURG");
    expect(canonicalStationId("Lille Europe (FR)", cw)).toBe("LILLE (intramuros)");
  });

  it("unifies identically-named stations across feeds without a crosswalk entry", () => {
    // Most stations need no entry at all — this is what keeps the crosswalk short
    // enough to stay correct.
    expect(canonicalStationId("Köln Hbf", cw)).toBe(canonicalStationId("Köln Hbf (DE)", cw));
    expect(canonicalStationId("Aachen Hbf", cw)).toBe("AACHEN HBF");
  });

  it("keeps genuinely different stations apart", () => {
    expect(canonicalStationId("Den Haag HS", cw)).not.toBe(canonicalStationId("Den Haag Centraal", cw));
    expect(canonicalStationId("Basel Bad Bf", cw)).not.toBe(canonicalStationId("Basel SBB", cw));
  });

  it("has a crosswalk whose entries never collide", () => {
    // Two canonical ids claiming the same feed name would make station identity
    // depend on object key order — a bug that would only show up as a missing route.
    const raw = crosswalkJson as Record<string, unknown>;
    const seen = new Map<string, string>();
    for (const [canonical, names] of Object.entries(raw)) {
      if (canonical.startsWith("_") || !Array.isArray(names)) continue;
      for (const n of names as string[]) {
        const key = normalizeStationName(n);
        const prev = seen.get(key);
        expect(prev === undefined || prev === canonical, `"${n}" claimed by ${prev} and ${canonical}`).toBe(true);
        seen.set(key, canonical);
      }
    }
  });
});
