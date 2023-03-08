import { Port } from "@port.finance/port-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PYTH_PROGRAM,
  SWITCHBOARD_PROGRAM_V1,
  SWITCHBOARD_PROGRAM_V2,
} from "../const";

const lendingMarkets = [
  "6T4XxKerq744sSuj3jaoV6QiZ8acirf4TrPwQzHAoSy5",
  "3VGB8mkJ7Po4DMhquiwZ5TY6T8si2oEzkTMLpke4aT3o",
  "9H2dexZJqrErvjaVvN8ZN3krA3sWS6WDXYx1xLQyzMqv",
  "HUYp9prDMdnQMfBYp9KQANTqCHW3R7fzQfjm89eeRpft",
];

async function main() {
  const conn = new Connection(
    "https://port-finance.rpcpool.com/385f15db-1967-4777-a05e-3c0ad9afd955"
  );
  await Promise.all(
    lendingMarkets.map(async (market) => {
      const port = Port.forMainNet({
        connection: conn,
        lendingMarket: new PublicKey(market),
      });
      const reserves = (await port.getReserveContext()).getAllReserves();
      await Promise.all(
        reserves.map(async (reserve) => {
          console.log(
            `asset mint id: ${reserve
              .getAssetMintId()
              .toString()}, share mint id: ${reserve.getShareMintId()}`
          );
          const oracleId = reserve.getOracleId();
          if (oracleId) {
            const oracleData = await conn.getAccountInfo(oracleId);
            console.log(
              `market: ${market}, reserve: ${reserve.getReserveId()}, oracleId: ${oracleId}, oracle owner: ${
                oracleData?.owner
              }, oracle feeder: ${
                oracleData?.owner.toString() === PYTH_PROGRAM
                  ? "PYTH"
                  : oracleData?.owner.toString() === SWITCHBOARD_PROGRAM_V1
                  ? "SB-V1"
                  : oracleData?.owner.toString() === SWITCHBOARD_PROGRAM_V2
                  ? "SB-V2"
                  : "unknown"
              }`
            );
            if (oracleData?.owner.toString() === SWITCHBOARD_PROGRAM_V1) {
              console.log(
                `market: ${market}, reserve: ${reserve.getReserveId()} oracle owner: ${
                  oracleData?.owner
                }, SB-v1 type: ${oracleData.data[0]}`
              );
            }
          } else {
            console.log(
              `market: ${market}, reserve: ${reserve.getReserveId()} no oracle `
            );
          }
        })
      );
    })
  );
}

main();
