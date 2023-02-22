import { AccountInfo, Connection } from "@solana/web3.js";
import { ReserveInfo, ReserveContext } from "@port.finance/port-sdk";
import Big from "big.js";
import { parsePriceData } from "@pythnetwork/client";
import { SwitchboardAccountType } from "@switchboard-xyz/switchboard-api";

const PYTH_PROGRAM = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH";
const SWITCH_BOARD_PROGRAM = "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f";

export async function readTokenPrices(
  connection: Connection,
  reserveContext: ReserveContext
): Promise<Map<string, Big>> {
  const tokenToCurrentPrice = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    tokenToCurrentPrice.set(
      reserve.getReserveId().toString(),
      await readSymbolPrice(connection, reserve)
    );
  }
  return tokenToCurrentPrice;
}

export async function readSymbolPrice(
  connection: Connection,
  reserve: ReserveInfo
): Promise<Big> {
  const oracleId = reserve.getOracleId();
  if (oracleId) {
    const oracleData = await connection.getAccountInfo(oracleId);
    if (!oracleData) {
      throw new Error("cannot fetch account oracle data");
    }
    return parseOracleData(oracleData, reserve);
  }

  return reserve.getMarkPrice().getRaw();
}

export function parseOracleData(
  accountInfo: AccountInfo<Buffer>,
  reserveInfo: ReserveInfo
): Big {
  if (accountInfo.owner.toString() === PYTH_PROGRAM) {
    const parsedPythData = parsePriceData(accountInfo.data);
    console.log(parsedPythData);
    if (!parsedPythData.price) {
      throw Error(`pyth price data is undefined`);
    }
    return new Big(parsedPythData.price);
  }

  // TODO: this is not actually parsing switchboard key, it's a temporary work around since I don't
  // know how to do it properly.
  if (accountInfo.owner.toString() === SWITCH_BOARD_PROGRAM) {
    if (
      accountInfo.data[0] ===
      SwitchboardAccountType.TYPE_AGGREGATOR_RESULT_PARSE_OPTIMIZED
    ) {
      return reserveInfo.getMarkPrice().getRaw();
    }
  }

  console.log(JSON.stringify(accountInfo));

  throw Error("Unrecognized oracle account");
}
