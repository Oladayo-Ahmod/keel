import { describe, expect, it } from "vitest";
import { isDemoSeller, marketNotice } from "./demo";

const team = new Set(["0x" + "a".repeat(40), "0x" + "b".repeat(40)]);
const A = "0x" + "A".repeat(40);
const X = "0x" + "c".repeat(40);

describe("demo listings", () => {
  it("marks a seller that is one of the team, in any letter case", () => {
    expect(isDemoSeller(A, team)).toBe(true);
    expect(isDemoSeller(X, team)).toBe(false);
  });

  it("says every listing is a demo when all sellers are the team", () => {
    const n = marketNotice([A, "0x" + "b".repeat(40)], team);
    expect(n).toMatchObject({ demo: 2, total: 2 });
    expect(n.text).toMatch(/Every listing shown is a demo listing/);
    expect(n.text).toMatch(/not user adoption/);
  });

  it("does not claim all activity is the team's once someone else lists", () => {
    const n = marketNotice([A, X], team);
    expect(n).toMatchObject({ demo: 1, total: 2 });
    expect(n.text).not.toMatch(/all activity/);
    expect(n.text).toMatch(/1 of the 2 listings shown is a demo listing/);
  });

  it("still states the label with nothing listed, and with no demo listings", () => {
    expect(marketNotice([], team).text).toMatch(/not user adoption/);
    expect(marketNotice([X], team).text).toMatch(/0 of the 1 listings shown are demo listings/);
  });
});
