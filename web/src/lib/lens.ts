import { config } from "@/config";
import { wave2 } from "@/config/wave2";

/**
 * The lens that knows a position. A wave 1 position and a wave 2 position can have the same NFT id, and each lens reads its
 * own NFT contract, so asking the wrong one answers for a different position, or for none.
 */
export const lensFor = (v2: boolean): `0x${string}` => (v2 ? wave2.lens : config.keel.lens);
