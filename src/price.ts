import { AccountInfo, Connection } from "@solana/web3.js";
import { ReserveInfo, ReserveContext, ReserveId } from "@port.finance/port-sdk";
import Big from "big.js";
import { parsePriceData } from "@pythnetwork/client";
import {
  AggregatorState,
  SwitchboardAccountType,
} from "@switchboard-xyz/switchboard-api";
import {
  portEnv,
  PYTH_PROGRAM,
  SWITCHBOARD_PROGRAM_V1,
  SWITCHBOARD_PROGRAM_V2,
} from "./const";
import { types as SBTypes } from "@switchboard-xyz/solana.js";
import { BN } from "@project-serum/anchor";

export async function readTokenPrices(
  connection: Connection,
  reserveContext: ReserveContext
): Promise<Map<string, Big>> {
  const tokenToCurrentPrice: Map<string, Big> = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    tokenToCurrentPrice.set(
      reserve.getReserveId().toString(),
      await readSymbolPrice(connection, reserve)
    );
  }
  return tokenToCurrentPrice;
}

async function readSymbolPrice(
  connection: Connection,
  reserve: ReserveInfo
): Promise<Big> {
  const oracleId = reserve.getOracleId();

  // const reserveName = portEnv
  //   .getAssetContext()
  //   .findConfigByReserveId(reserve.getReserveId())
  //   ?.getDisplayConfig()
  //   .getName();

  if (oracleId) {
    const oracleData = await connection.getAccountInfo(oracleId);
    if (!oracleData) {
      throw new Error("cannot fetch account oracle data");
    }
    // console.log(
    //   `ReserveId: ${reserve
    //     .getReserveId()
    //     .toString()}, Token: ${reserveName} price from oracle`
    // );
    return parseOracleData(oracleData, reserve);
  }

  // console.log(`Token: ${reserveName} price from mark price`);
  return reserve.getMarkPrice().getRaw();
}

function parseOracleData(
  accountInfo: AccountInfo<Buffer>,
  reserveInfo: ReserveInfo
): Big {
  if (accountInfo.owner.toString() === PYTH_PROGRAM) {
    const parsedPythData = parsePriceData(accountInfo.data);
    if (!parsedPythData.price) {
      throw Error(`pyth price data is undefined`);
    }
    return Big(parsedPythData.price);
  }

  if (accountInfo.owner.toString() === SWITCHBOARD_PROGRAM_V1) {
    const dataFeed = parseSBV1PriceData(accountInfo);
    if (!dataFeed) {
      return reserveInfo.getMarkPrice().getRaw();
    }
    // console.log("sb-v1 ", dataFeed.toString());
    return Big(dataFeed);
  } else if (accountInfo.owner.toString() === SWITCHBOARD_PROGRAM_V2) {
    const feed = SBTypes.AggregatorAccountData.decode(accountInfo.data);
    if (feed.minOracleResults > feed.latestConfirmedRound.numSuccess) {
      throw Error(`Invalid switchboard-v2 account current round result`);
    }
    const priceDesc = feed.latestConfirmedRound.result;
    const price = Big(priceDesc.mantissa.toString()).div(
      Big(10).pow(priceDesc.scale)
    );

    // console.log("sb-v2 ", price.toString());
    return price;
  }

  throw Error("Unrecognized oracle account");
}

function parseSBV1PriceData(accountInfo: AccountInfo<Buffer>) {
  const data = accountInfo.data;

  if (data.length <= 0) {
    throw Error(`switchboard-v1 account data is empty`);
  }

  switch (data[0]) {
    case SwitchboardAccountType.TYPE_AGGREGATOR:
      const aggregator = AggregatorState.decodeDelimited(data.subarray(1));
      const config = aggregator.configs;
      if (!config || !config.minConfirmations) {
        throw Error(`Invalid switchboard-v1 account config`);
      }
      let maybeRound = aggregator.currentRoundResult;

      if (
        !maybeRound ||
        !maybeRound.numSuccess ||
        maybeRound.numSuccess < config.minConfirmations
      ) {
        maybeRound = aggregator.lastRoundResult;
        if (!maybeRound) {
          throw Error(`Invalid switchboard-v1 account current round result`);
        }
      }
      if (!maybeRound.result) {
        throw Error(
          `Invalid switchboard-v1 account current round result price data`
        );
      }

      return maybeRound.result;
    case SwitchboardAccountType.TYPE_AGGREGATOR_RESULT_PARSE_OPTIMIZED:
      const round = decodeSBV1OptimizedPrice(data);
      console.log(`data: ${JSON.stringify(data)}`);
      console.log(`switchbaord v1 round: ${JSON.stringify(round)}`);
      return round.result.result;
    default:
      console.log(`Invalid switchboard-v1 account data type`);
      return undefined;
  }
}

function decodeSBV1OptimizedPrice(data: Buffer) {
  // skip account type
  const buf = data.subarray(1);
  if (buf.length < 104) {
    throw Error(
      `Invalid switchboard-v1 account data length for parse optimized`
    );
  }
  return {
    parent: Uint8Array.from(buf.subarray(0, 32)),
    result: {
      numSuccess: buf.subarray(32, 36).readInt32LE(),
      numError: buf.subarray(36, 40).readInt32LE(),
      result: buf.subarray(40, 48).readDoubleLE(),
      roundOpenSlot: Number(buf.subarray(48, 56).readBigUint64LE()),
      roundOpenTimestamp: Number(buf.subarray(56, 64).readBigUint64LE()),
      minResponse: buf.subarray(64, 72).readDoubleLE(),
      maxResponse: buf.subarray(72, 80).readDoubleLE(),
      decimal: new SBTypes.SwitchboardDecimal({
        mantissa: new BN(buf.subarray(80, 96).reverse()),
        scale: Number(buf.subarray(96, 104).readBigUint64LE()),
      }),
    },
  };
}