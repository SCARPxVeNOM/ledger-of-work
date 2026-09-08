import { describe, expect, it } from "vitest";
import { parseHitText, virgoAdapter } from "../src/adapters/virgo.js";

// Copied verbatim from a live Virgo result.
const TITLE = "Climatic Change: A Bibliography of Recent Literature";
const TEXT =
  "1 Climatic Change: A Bibliography of Recent Literature Cite Freshwater Biological Association " +
  "Format: Book Publication Date: 1991 Availability: Request Library: Ivy Location: By Request " +
  "Call Number: MINCAT AJK8855";

describe("parseHitText", () => {
  const rec = parseHitText("u1931468", TITLE, TEXT);

  it("reads the labelled fields", () => {
    expect(rec.format).toBe("Book");
    expect(rec.year).toBe(1991);
    expect(rec.library).toBe("Ivy");
    expect(rec.callNumber).toBe("MINCAT AJK8855");
  });

  it("stops each field at the next label rather than swallowing the rest", () => {
    // "Library: Ivy Location: By Request" must not make library "Ivy Location: By Request".
    expect(rec.library).toBe("Ivy");
    expect(rec.format).toBe("Book");
  });

  it("extracts the author between the title and the first label", () => {
    expect(rec.author).toBe("Freshwater Biological Association");
  });

  it("builds a stable item URL from the id", () => {
    expect(rec.url).toBe("https://search.lib.virginia.edu/sources/uva_library/items/u1931468");
    expect(rec.id).toBe("u1931468");
  });

  it("returns null rather than guessing when a field is absent", () => {
    const sparse = parseHitText("u1", "Some Title", "1 Some Title Cite Format: Journal");
    expect(sparse.format).toBe("Journal");
    expect(sparse.year).toBeNull();
    expect(sparse.library).toBeNull();
    expect(sparse.callNumber).toBeNull();
  });

  it("pulls a year out of a messier date string", () => {
    const r = parseHitText("u2", "T", "1 T Cite A Publication Date: c2003, printed 2005 Format: Book");
    expect(r.year).toBe(2003);
  });

  it("ignores numbers that are not plausible years", () => {
    const r = parseHitText("u3", "T", "1 T Cite A Publication Date: no date Format: Book");
    expect(r.year).toBeNull();
  });

  it("stops the call number at a following label", () => {
    // An online record appends "Access Online:" after the call number. Without that in
    // the known-label set the call number swallowed the rest of the line.
    const r = parseHitText(
      "u4",
      "Teaching Climate Change",
      "2 Teaching Climate Change Cite Siperstein, Stephen Format: EBook Publication Date: 2016 " +
        "Library: UVA Library Call Number: QC903 Access Online: Library Catalog (Click to View)",
    );
    expect(r.callNumber).toBe("QC903");
    expect(r.library).toBe("UVA Library");
  });

  it("survives a title containing a colon, which the labels also use", () => {
    expect(rec.title).toBe(TITLE);
    expect(rec.title).toContain(":");
  });
});

describe("virgo parameters", () => {
  it("requires a query of sensible length", () => {
    expect(() => virgoAdapter.normalise({ query: "a" })).toThrow(/query/);
    expect(() => virgoAdapter.normalise({ query: "x".repeat(121) })).toThrow(/query/);
    expect(() => virgoAdapter.normalise({})).toThrow(/query/);
  });

  it("rejects characters that do not belong in a catalogue search", () => {
    expect(() => virgoAdapter.normalise({ query: "<script>" })).toThrow(/query/);
    expect(() => virgoAdapter.normalise({ query: "a\\b" })).toThrow(/query/);
  });

  it("caps max low, because this is a working library", () => {
    expect(() => virgoAdapter.normalise({ query: "climate", max: 61 })).toThrow(/max/);
    expect(virgoAdapter.normalise({ query: "climate", max: 60 }).max).toBe(60);
  });

  it("trims the query", () => {
    expect(virgoAdapter.normalise({ query: "  climate change  " }).query).toBe("climate change");
  });
});

describe("virgo plan", () => {
  it("charges one navigation plus one click per further batch of twenty", () => {
    const p = (max: number) => virgoAdapter.plan(virgoAdapter.normalise({ query: "climate", max }));
    expect(p(20).steps).toBe(1);
    expect(p(21).steps).toBe(2);
    expect(p(60).steps).toBe(3);
  });

  it("charges more for more results — the reason this flow is metered at all", () => {
    const small = virgoAdapter.plan(virgoAdapter.normalise({ query: "climate", max: 5 }));
    const large = virgoAdapter.plan(virgoAdapter.normalise({ query: "climate", max: 60 }));
    expect(large.steps).toBeGreaterThan(small.steps);
    expect(large.pages).toBeGreaterThan(small.pages);
  });

  it("stays inside its own ceilings", () => {
    const p = virgoAdapter.plan(virgoAdapter.normalise({ query: "climate", max: 60 }));
    expect(p.steps).toBeLessThanOrEqual(virgoAdapter.spec.limits.maxSteps);
    expect(p.pages).toBeLessThanOrEqual(virgoAdapter.spec.limits.maxPages);
  });

  it("is pure", () => {
    const params = virgoAdapter.normalise({ query: "climate", max: 40 });
    expect(virgoAdapter.plan(params)).toEqual(virgoAdapter.plan(params));
  });

  it("names the query so the quote is legible before paying", () => {
    const p = virgoAdapter.plan(virgoAdapter.normalise({ query: "climate change", max: 40 }));
    expect(p.outline[0]).toContain("climate change");
  });
});
