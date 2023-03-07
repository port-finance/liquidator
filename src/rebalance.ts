import { Port } from "@port.finance/port-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import Big from "big.js";
import { getOwnedTokenAccounts } from "./account";
import { LAMPORT_DECIMAL, LiquidatorConfig, SOL_MINT } from "./const";
import { log } from "./infra/logger";
import { JupiterSwap } from "./infra/thrid/swap";
import { getTokenPrices } from "./price";

export const loadPositionConfig = async (portSDK: Port) => {
  const { stableCoin, valueRatios } = LiquidatorConfig;
  const reserveList = await (
    await portSDK.getReserveContext()
  ).getAllReserves();

  const resertMintSet = Array.from(
    new Set(
      reserveList.flatMap((reserve) => [
        reserve.getAssetMintId().toString(),
        // For now, just collateral asset, don't concern LP asset
        // reserve.getShareMintId().toString(),
      ])
    ).keys()
  );

  return {
    stableCoin,
    valueRatios: Object.fromEntries(
      resertMintSet
        .filter((t) => t !== stableCoin)
        .map((t) => [t, valueRatios.overrides[t] ?? valueRatios.default])
    ),
  };
};

export const rebalanceCoins = async (
  portSDK: Port,
  conn: Connection,
  jupiterSwap: JupiterSwap,
  wallet: PublicKey
) => {
  const coinPrice = await getTokenPrices(
    conn,
    await portSDK.getReserveContext(),
    portSDK.environment.getAssetContext()
  );
  const solBalance = Big(await conn.getBalance(wallet)).div(LAMPORT_DECIMAL);
  const tokensBalance = Object.fromEntries(
    (await getOwnedTokenAccounts(conn, wallet)).map((tokenAccount) => {
      return [
        tokenAccount.mint.toString(),
        {
          balance: Big(tokenAccount.amount.toString()).div(
            Big(10).pow(tokenAccount.tokenAmount.decimals)
          ),
          decimal: Big(10).pow(tokenAccount.tokenAmount.decimals),
        },
      ];
    })
  );
  tokensBalance[SOL_MINT] = {
    balance: solBalance,
    decimal: Big(LAMPORT_DECIMAL),
  };

  const aggCoinInfo = getAggCoinInfo(tokensBalance, coinPrice);

  const { stableCoin, valueRatios } = await loadPositionConfig(portSDK);
  const getCoinValueTarget = await (async () => {
    const totalValue = Array.from(Object.values(aggCoinInfo)).reduce(
      (acc, { value }) => acc.add(value),
      Big(0)
    );
    const stableTargetValue = totalValue.div(
      Object.values(valueRatios).reduce((acc, r) => acc.add(r), Big(1))
    );
    return (coinType: string) =>
      valueRatios[coinType] !== undefined
        ? stableTargetValue.mul(valueRatios[coinType])
        : undefined;
  })();

  // slippage tolerence 0.01%
  const slippageBps = 100;
  const getCoinSwapOption = async (coinType: string) => {
    const coinInfo = aggCoinInfo[coinType];
    const valueTarget = getCoinValueTarget(coinType);
    if (valueTarget === undefined) {
      return null;
    }

    const coinValueToChange = valueTarget.sub(coinInfo.value);
    const exchangeLower = coinInfo.value.mul(0.2).gt(5)
      ? coinInfo.value.mul(0.2)
      : Big(5);
    if (coinValueToChange.abs().lt(exchangeLower)) {
      return null;
    }

    const [fromCoinType, toCoinType] = coinValueToChange.gt(0)
      ? [stableCoin, coinType]
      : [coinType, stableCoin];
    const inputAmount = coinValueToChange
      .abs()
      .mul(aggCoinInfo[fromCoinType].decimal)
      .div(aggCoinInfo[fromCoinType].price)
      .round(undefined, 0);

    return {
      inputMint: fromCoinType,
      outputMint: toCoinType,
      inputAmount: inputAmount,
    };
  };

  const swapSequence = Object.keys(aggCoinInfo)
    .filter((t) => t !== stableCoin)
    .map((t) => {
      const valueTarget = getCoinValueTarget(t);
      return {
        coinType: t,
        diffUSD:
          valueTarget !== undefined
            ? valueTarget.minus(aggCoinInfo[t].value)
            : null,
      };
    })
    .filter((v): v is { coinType: string; diffUSD: Big } => !!v.diffUSD)
    .sort((a, b) => a.diffUSD.minus(b.diffUSD).toNumber())
    .map((v) => v.coinType);

  for (const coinType of swapSequence) {
    const payload = await getCoinSwapOption(coinType);
    if (payload) {
      try {
        const res = await jupiterSwap.swapWithBestRoute(
          new PublicKey(payload.inputMint),
          new PublicKey(payload.outputMint),
          payload.inputAmount,
          slippageBps
        );
        log.trace.warn(`Jupiter swap success`, {
          transaction: res.txid,
          inputTokenAccount: res.inputAddress.toString(),
          outputTokenAccount: res.outputAddress.toString(),
          inputAmount: res.inputAmount,
          outputAmount: res.outputAmount,
        });
      } catch (e) {
        log.alert.warn(`rebalance swap failed: ${e}, payload:`, payload);
      }
    }
  }
};

function getAggCoinInfo(
  coinBalance: {
    [k: string]: {
      balance: Big;
      decimal: Big;
    };
  },
  coinPrice: Map<
    string,
    {
      price: Big;
      assetName: string;
    }
  >
) {
  return Object.fromEntries(
    Array.from(Object.entries(coinBalance))
      .map(([mint, amount]) => {
        const price = coinPrice.get(mint);
        if (!price) {
          return undefined;
        }
        return [
          mint,
          {
            value: amount.balance.mul(price.price),
            amount: amount.balance,
            decimal: amount.decimal,
            price: price.price,
            assetName: price.assetName,
          },
        ];
      })
      .filter(
        (
          val
        ): val is [
          string,
          {
            value: Big;
            decimal: Big;
            amount: Big;
            price: Big;
            assetName: string;
          }
        ] => !!val
      )
  );
}
