import {
  PortProfile,
  Port,
  ReserveContext,
  ReserveId,
} from "@port.finance/port-sdk";
import { Connection } from "@solana/web3.js";
import { readReservePrices } from "./price";
import Big from "big.js";
import { AssetDetail, EnrichedObligation } from "./types";
import { DISPLAY_FIRST, portEnv, ZERO } from "./const";
import { log } from "./infra/logger";

export async function getUnhealthyObligations(connection: Connection) {
  const mainnetPort = Port.forMainNet({
    connection: connection,
  });
  const portBalances = await mainnetPort.getAllPortProfiles();
  const reserves = await mainnetPort.getReserveContext();
  const tokenToCurrentPrice = await readReservePrices(connection, reserves);
  const sortedObligations = portBalances
    .filter((obligation) => !isNoBorrow(obligation))
    .filter((obligation) => !willNeverLiquidate(obligation))
    .filter((obligation) => !isInsolvent(obligation))
    .map((obligation) =>
      generateEnrichedObligation(obligation, tokenToCurrentPrice, reserves)
    )
    .sort((obligation1, obligation2) => {
      return obligation2.riskFactor * 100 - obligation1.riskFactor * 100;
    });

  log.common.info(
    `Total number of loans are ${portBalances.length} and possible liquidation debts are ${sortedObligations.length}`
  );

  sortedObligations.slice(0, DISPLAY_FIRST).forEach((ob) =>
    log.common.info(`Risk factor: ${ob.riskFactor.toFixed(
      4
    )} borrowed amount: ${ob.totalLoanValue} liquidation loan value amount: ${
      ob.totalLiquidationLoanValue
    }
borrowed asset names: [${ob.loanAssetNames.toString()}] deposited asset names: [${ob.depositedAssetNames.toString()}]
obligation pubkey: ${ob.obligation.getProfileId().toString()}`)
  );

  tokenToCurrentPrice.forEach((price: Big, token: string) => {
    log.common.info(
      `name: ${portEnv
        .getAssetContext()
        .findConfigByReserveId(ReserveId.fromBase58(token))
        ?.getDisplayConfig()
        .getName()}, reserveId: ${token}, price: ${price.toString()}\n`
    );
  });

  return sortedObligations.filter(
    (obigation) =>
      obigation.riskFactor >= 1 && obigation.totalLoanValue.gte(0.08)
  );
}

function willNeverLiquidate(obligation: PortProfile): boolean {
  const loans = obligation.getLoans();
  const collaterals = obligation.getCollaterals();
  return (
    loans.length === 1 &&
    collaterals.length === 1 &&
    loans[0].getReserveId().toString() ===
      collaterals[0].getReserveId().toString()
  );
}

function isInsolvent(obligation: PortProfile): boolean {
  return (
    obligation.getLoans().length > 0 && obligation.getCollaterals().length === 0
  );
}

function isNoBorrow(obligation: PortProfile): boolean {
  return obligation.getLoans().length === 0;
}

function generateEnrichedObligation(
  obligation: PortProfile,
  tokenToCurrentPrice: Map<string, Big>,
  reserveContext: ReserveContext
): EnrichedObligation {
  let totalLoanValue = new Big(0);
  const loanAssetNames: string[] = [];
  const assetCtx = portEnv.getAssetContext();
  const loanDetails: Record<string, AssetDetail> = {};
  const depositDetails: Record<string, AssetDetail> = {};

  for (const loan of obligation.getLoans()) {
    const reservePubKey = loan.getReserveId().toString();
    const name = assetCtx
      .findConfigByReserveId(ReserveId.fromBase58(reservePubKey))
      ?.getDisplayConfig()
      .getSymbol();
    const reserve = reserveContext.getReserve(loan.getReserveId());
    const tokenPrice: Big | undefined = tokenToCurrentPrice.get(reservePubKey);
    if (!tokenPrice) {
      throw new Error("token price not found");
    }

    const loanValue = loan
      .accrueInterest(reserve.asset.getCumulativeBorrowRate())
      .getRaw()
      .mul(tokenPrice)
      .div(reserve.getQuantityContext().multiplier);
    totalLoanValue = totalLoanValue.add(loanValue);
    loanAssetNames.push(name ?? "unknown");

    loanDetails[reservePubKey] = {
      assetName: name,
      price: tokenPrice,
      value: loanValue,
    };
  }

  let totalLiquidationLoanValue: Big = new Big(0);
  const depositedAssetNames: string[] = [];
  for (const deposit of obligation.getCollaterals()) {
    const reservePubKey = deposit.getReserveId().toString();
    const name = assetCtx
      .findConfigByReserveId(ReserveId.fromBase58(reservePubKey))
      ?.getDisplayConfig()
      .getSymbol();
    const reserve = reserveContext.getReserve(deposit.getReserveId());
    const exchangeRatio = reserve.getExchangeRatio().getPct();
    const liquidationThreshold = reserve.params.liquidationThreshold.getRaw();
    const tokenPrice = tokenToCurrentPrice.get(reservePubKey);
    if (!tokenPrice || !exchangeRatio) {
      throw new Error("error in token price or exchange ratio");
    }
    const liquidationLoanValue = deposit
      .getRaw()
      .div(exchangeRatio.getRaw())
      .mul(tokenPrice)
      .mul(liquidationThreshold)
      .div(reserve.getQuantityContext().multiplier);
    totalLiquidationLoanValue =
      totalLiquidationLoanValue.add(liquidationLoanValue);
    depositedAssetNames.push(name ?? "unknown");

    depositDetails[reservePubKey] = {
      assetName: name,
      price: tokenPrice,
      value: deposit
        .getRaw()
        .div(exchangeRatio.getRaw())
        .mul(tokenPrice)
        .div(reserve.getQuantityContext().multiplier),
    };
  }

  const riskFactor: number =
    totalLiquidationLoanValue.eq(ZERO) || totalLoanValue.eq(ZERO)
      ? 0
      : totalLoanValue.div(totalLiquidationLoanValue).toNumber();

  return {
    totalLoanValue,
    totalLiquidationLoanValue,
    riskFactor,
    obligation,
    loanAssetNames,
    depositedAssetNames,
    loanDetails,
    depositDetails,
  };
}
