import { Environment } from "@port.finance/port-sdk";
import { PublicKey } from "@solana/web3.js";
import Big from "big.js";

export const portEnv = Environment.forMainNet();

export const STAKING_PROGRAM_ID = new PublicKey(
  "stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq"
);
export const ZERO: Big = new Big(0);

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const DISPLAY_FIRST = 20;
