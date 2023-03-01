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
    await portSDK.getReserveContext()
  );
  const solBalance = Big(await conn.getBalance(wallet)).div(LAMPORT_DECIMAL);
  const tokensBalance = new Map(
    await (
      await getOwnedTokenAccounts(conn, wallet)
    ).map((tokenAccount) => {
      return [
        tokenAccount.mint.toString(),
        Big(tokenAccount.amount.toString()),
      ];
    })
  );
  tokensBalance.set(SOL_MINT, solBalance);

  const aggCoinInfo = new Map(
    Array.from(tokensBalance.entries())
      .map(([mint, amount]) => {
        const price = coinPrice.get[mint];
        if (!price) {
          return undefined;
        }
        return [
          mint,
          {
            value: amount.mul(price),
            amount: amount,
            price: price,
          },
        ];
      })
      .filter(
        (val): val is [string, { value: Big; amount: Big; price: Big }] => !!val
      )
  );

  const { stableCoin, valueRatios } = await loadPositionConfig(portSDK);
  const getCoinValueTarget = await (async () => {
    const totalValue = Array.from(aggCoinInfo.values()).reduce(
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
    const coinInfo = aggCoinInfo.get(coinType);
    const valueTarget = getCoinValueTarget(coinType);
    if (coinInfo === undefined || valueTarget === undefined) {
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

    // BUY
    return {
      input: fromCoinType,
      output: toCoinType,
      amount: coinValueToChange.abs().div(coinInfo.price),
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
            ? valueTarget.minus(aggCoinInfo.get(t)?.value ?? 0)
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
          new PublicKey(payload.input),
          new PublicKey(payload.output),
          payload.amount,
          slippageBps
        );
        log.trace.warn(
          `Jupiter swap success,transaction: ${res.txid}
        inputAddress=${res.inputAddress.toString()} outputAddress=${res.outputAddress.toString()}
        inputAmount=${res.inputAmount} outputAmount=${res.outputAmount}`
        );
      } catch (e) {
        log.alert.warn(`rebalance swap failed: ${e}`);
      }
    }
  }
};
