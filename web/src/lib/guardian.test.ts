import { describe, expect, it } from "vitest";
import { trozuVaultAbi } from "@/abi/trozu";
import {
  LIMITS,
  describePlan,
  kindName,
  policyLive,
  policyWarnings,
  reasonName,
  remaining,
  validatePolicy,
  windowFresh,
  type PolicyInput,
} from "./guardian";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const good: PolicyInput = {
  floorIcr: e18(1.3), targetIcr: e18(1.6),
  maxActionBtc: e18(0.01), maxActionMusd: e18(500),
  periodCapBtc: e18(0.02), periodCapMusd: e18(1000),
  keeperTipBtc: e18(0.00005), bufferFloorMusd: 0n,
  period: 86400, maxWalkSteps: 0,
};

describe("policy validation, one case per contract revert", () => {
  it("accepts a sensible policy", () => {
    expect(validatePolicy(good)).toEqual([]);
  });
  it("floor must be above 110%", () => {
    expect(validatePolicy({ ...good, floorIcr: e18(1.1) }).join()).toMatch(/above 110%/);
    expect(validatePolicy({ ...good, floorIcr: e18(1.1) + 1n }).join()).not.toMatch(/above 110%/);
  });
  it("target must be above floor and not above 500%", () => {
    expect(validatePolicy({ ...good, targetIcr: good.floorIcr }).join()).toMatch(/target has to be above the floor/);
    expect(validatePolicy({ ...good, targetIcr: e18(5.01) }).join()).toMatch(/500%/);
    expect(validatePolicy({ ...good, targetIcr: e18(5) }).join()).not.toMatch(/500%/);
  });
  it("period must be 1 hour to 30 days", () => {
    expect(validatePolicy({ ...good, period: 3599 }).join()).toMatch(/1 hour and 30 days/);
    expect(validatePolicy({ ...good, period: 3600 })).toEqual([]);
    expect(validatePolicy({ ...good, period: 30 * 86400 + 1 }).join()).toMatch(/1 hour and 30 days/);
  });
  it("tip is capped", () => {
    expect(validatePolicy({ ...good, keeperTipBtc: LIMITS.maxKeeperTip + 1n }).join()).toMatch(/keeper tip/);
  });
  it("some action must be allowed", () => {
    expect(validatePolicy({ ...good, maxActionBtc: 0n, maxActionMusd: 0n }).join()).toMatch(/at least one kind/);
  });
  it("an action cannot exceed its period cap", () => {
    expect(validatePolicy({ ...good, maxActionBtc: e18(0.03) }).join()).toMatch(/larger than the period cap/);
    expect(validatePolicy({ ...good, maxActionMusd: e18(2000) }).join()).toMatch(/larger than the period cap/);
  });
  it("a tip has to stay under the BTC period cap", () => {
    const p = { ...good, keeperTipBtc: e18(0.00005), periodCapBtc: e18(0.00005), maxActionBtc: 0n };
    expect(validatePolicy(p).join()).toMatch(/tip has to be below/);
  });
  it("walk length is capped, and defense needs a walk and a BTC limit", () => {
    expect(validatePolicy({ ...good, maxWalkSteps: 101 }).join()).toMatch(/100 troves/);
    expect(validatePolicy({ ...good, bufferFloorMusd: e18(1000), maxWalkSteps: 0 }).join()).toMatch(/Redemption defense needs/);
    expect(validatePolicy({ ...good, bufferFloorMusd: e18(1000), maxWalkSteps: 50, maxActionBtc: 0n }).join()).toMatch(/Redemption defense needs/);
    expect(validatePolicy({ ...good, bufferFloorMusd: e18(1000), maxWalkSteps: 50 })).toEqual([]);
  });
  it("collects several problems at once", () => {
    expect(validatePolicy({ ...good, floorIcr: e18(1), period: 1 }).length).toBe(2);
  });
});

describe("policy warnings", () => {
  it("flags a floor under 130%, a missing tip, and a cramped defense", () => {
    expect(policyWarnings({ ...good, floorIcr: e18(1.2), targetIcr: e18(1.6) }).join()).toMatch(/under 130%/);
    expect(policyWarnings({ ...good, keeperTipBtc: 0n }).join()).toMatch(/no tip/);
    expect(policyWarnings({ ...good, bufferFloorMusd: 1n, targetIcr: e18(1.35) }).join()).toMatch(/Redemption defense raises/);
    expect(policyWarnings(good)).toEqual([]);
  });
});

describe("plan wording", () => {
  it("reads the enums in the contract's order", () => {
    expect([0, 1, 2, 3].map(kindName)).toEqual(["None", "TopUpBtc", "RepayMusd", "DefendBtc"]);
    expect(reasonName(5)).toBe("Healthy");
    expect(reasonName(8)).toBe("BelowMinimum");
    expect(kindName(9)).toBe("None");
  });
  it("explains each outcome", () => {
    expect(describePlan({ kind: "None", reason: "NoPolicy", amount: 0n, tip: 0n, icr: 0n })).toMatch(/No policy/);
    expect(describePlan({ kind: "None", reason: "PolicyStale", amount: 0n, tip: 0n, icr: 0n })).toMatch(/previous holder/);
    expect(describePlan({ kind: "TopUpBtc", reason: "None", amount: e18(0.01), tip: e18(0.00005), icr: e18(1.25) })).toMatch(/0.01000 BTC.*125.0%.*0.00005 BTC/);
    expect(describePlan({ kind: "RepayMusd", reason: "None", amount: e18(300), tip: 0n, icr: e18(1.25) })).toMatch(/300.00 MUSD/);
    expect(describePlan({ kind: "DefendBtc", reason: "None", amount: e18(0.01), tip: 0n, icr: e18(1.5) })).toMatch(/redemption buffer/);
  });
  it("keeps the holder's manual refinance and has no separate guardian refinance entry point", () => {
    const names = trozuVaultAbi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names).toContain("refinance");
    expect(names).toContain("execute");
    // the only function with "refinance" in its name is the holder's own wrapper
    expect(names.filter((n) => /refin/i.test(n))).toEqual(["refinance"]);
  });
});

describe("period maths", () => {
  it("remaining never goes negative", () => {
    expect(remaining(10n, 4n)).toBe(6n);
    expect(remaining(10n, 12n)).toBe(0n);
  });
  it("a window rolls over exactly at start plus period", () => {
    expect(windowFresh(1000n, 3600, 4599n)).toBe(false);
    expect(windowFresh(1000n, 3600, 4600n)).toBe(true);
    expect(windowFresh(0n, 3600, 100n)).toBe(false);
  });
  it("a policy is live only for the epoch it was set under", () => {
    expect(policyLive({ active: true, epoch: 2n }, 2n)).toBe(true);
    expect(policyLive({ active: true, epoch: 2n }, 3n)).toBe(false);
    expect(policyLive({ active: false, epoch: 2n }, 2n)).toBe(false);
  });
});

describe("the ABI matches the Policy the form builds", () => {
  it("setPolicy takes the fields validatePolicy knows about", () => {
    const sp = trozuVaultAbi.find((x) => x.type === "function" && x.name === "setPolicy") as unknown as {
      inputs: { components: { name: string }[] }[];
    };
    const names = sp.inputs[0].components.map((c) => c.name);
    for (const k of Object.keys(good)) expect(names).toContain(k);
    expect(names).toEqual(expect.arrayContaining(["epoch", "active"]));
  });
});

import { parseOptional, parsePercent, suggestPolicy } from "./guardian";

describe("form parsing", () => {
  it("empty means zero, junk is rejected", () => {
    expect(parseOptional("")).toBe(0n);
    expect(parseOptional("0")).toBe(0n);
    expect(parseOptional("1.5")).toBe(e18(1.5));
    expect(parseOptional("abc")).toBeUndefined();
    expect(parseOptional("-1")).toBeUndefined();
    expect(parseOptional("1.2.3")).toBeUndefined();
    expect(parseOptional("1." + "0".repeat(19))).toBeUndefined();
  });
  it("percent becomes a 1e18 ratio", () => {
    expect(parsePercent("130")).toBe(e18(1.3));
    expect(parsePercent("162.5")).toBe(e18(1.625));
    expect(parsePercent("0")).toBeUndefined();
    expect(parsePercent("")).toBeUndefined();
  });
  it("a suggested policy is valid for any sensible position", () => {
    expect(validatePolicy(suggestPolicy(e18(0.05), e18(1_800)))).toEqual([]);
    expect(validatePolicy(suggestPolicy(e18(2), e18(90_000)))).toEqual([]);
  });
});
