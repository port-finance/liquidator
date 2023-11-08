import { Environment } from "@port.finance/port-sdk";
import { PublicKey } from "@solana/web3.js";
import Big from "big.js";
import { readFileSync } from "fs";

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

export const DEPRECATED_RESERVES = [
  "BnhsmYVvNjXK3TGDHLj1Yr1jBGCmD1gZMkAyCwoXsHwt",
];

export const PORT_ENV = (() => {
  return {
    HEARTBEAT_WEBHOOK_URL: process.env.HEARTBEAT_WEBHOOK_URL,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
    TRACE_WEBHOOK_URL: process.env.TRACE_WEBHOOK_URL,
    KEYPAIR: process.env.KEYPAIR!,
    PROGRAM_ID: new PublicKey(
      process.env.PROGRAM_ID ?? "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR"
    ),
    CLUSTER_URL:
      process.env.CLUSTER_URL ??
      "https://port-finance.rpcpool.com/385f15db-1967-4777-a05e-3c0ad9afd955",
    CHECK_INTERVAL: parseFloat(process.env.CHECK_INTERVAL || "10000"),
    CONFIG_FILE: process.env.CONFIG_FILE ?? "./config/liquidator.json",
  };
})();

export const LiquidatorConfig = JSON.parse(
  readFileSync(PORT_ENV.CONFIG_FILE).toString()
) as {
  stableCoin: string;
  valueRatios: {
    default: number;
    overrides: Record<string, number>;
  };
};
