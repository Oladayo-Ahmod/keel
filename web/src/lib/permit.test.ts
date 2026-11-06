import { describe, expect, it } from "vitest";
import { hashDomain, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PERMIT_TYPES, domainMatches, permitDomain, permitMessage, splitSignature } from "./permit";

const musd = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as const;
const dom = { name: "Mezo USD", chainId: 31611, verifyingContract: musd };

// a random key made for this run, never a real one
const account = privateKeyToAccount(generatePrivateKey());

const separator = hashDomain({
  domain: { ...permitDomain(dom), chainId: BigInt(dom.chainId) },
  types: { EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ] },
});

describe("permit", () => {
  it("accepts the separator it would produce and rejects a different one", () => {
    expect(domainMatches(dom, separator)).toBe(true);
    expect(domainMatches({ ...dom, name: "MUSD" }, separator)).toBe(false);
    expect(domainMatches({ ...dom, chainId: 1 }, separator)).toBe(false);
  });

  it("signs a message that recovers to the owner, and splits into v r s", async () => {
    const message = permitMessage({ owner: account.address, spender: musd, value: 5n, nonce: 0n, deadline: 99n });
    const signature = await account.signTypedData({ domain: permitDomain(dom), types: PERMIT_TYPES, primaryType: "Permit", message });
    const back = await recoverTypedDataAddress({ domain: permitDomain(dom), types: PERMIT_TYPES, primaryType: "Permit", message, signature });
    expect(back).toBe(account.address);
    const { v, r, s } = splitSignature(signature);
    expect([27, 28]).toContain(v);
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
