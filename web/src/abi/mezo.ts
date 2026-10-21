// The few Mezo functions the app calls directly. Signatures checked against
// mezo-org/musd at aa25fd6.

export const hintHelpersAbi = [
  {
    type: "function",
    name: "getApproxHint",
    stateMutability: "view",
    inputs: [
      { name: "_CR", type: "uint256" },
      { name: "_numTrials", type: "uint256" },
      { name: "_inputRandomSeed", type: "uint256" },
    ],
    outputs: [
      { name: "hintAddress", type: "address" },
      { name: "diff", type: "uint256" },
      { name: "latestRandomSeed", type: "uint256" },
    ],
  },
] as const;

export const sortedTrovesAbi = [
  {
    type: "function",
    name: "findInsertPosition",
    stateMutability: "view",
    inputs: [
      { name: "_NICR", type: "uint256" },
      { name: "_prevId", type: "address" },
      { name: "_nextId", type: "address" },
    ],
    outputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
  },
] as const;

export const borrowerOperationsAbi = [
  {
    type: "function",
    name: "getBorrowingFee",
    stateMutability: "view",
    inputs: [{ name: "_debt", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "minNetDebt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const priceFeedAbi = [
  {
    type: "function",
    name: "fetchPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
