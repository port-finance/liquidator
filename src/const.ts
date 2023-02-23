import { Environment } from "@port.finance/port-sdk";
import { PublicKey } from "@solana/web3.js";
import Big from "big.js";

export const portEnv = Environment.forMainNet();

export const STAKING_PROGRAM_ID = new PublicKey(
  "stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq"
);
export const ZERO: Big = new Big(0);
export const LIQUIDATOR_REDUCE_FACTOR = 0.8;

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORT_DECIMAL = 1_000_000_000;
export const DISPLAY_FIRST = 20;

export const PYTH_PROGRAM = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH";
export const SWITCHBOARD_PROGRAM_V1 =
  "DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM";
export const SWITCHBOARD_PROGRAM_V2 =
  "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f";
