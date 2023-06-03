import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { sendTransaction, sleep } from "./utils";
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { AnchorProvider, Wallet, BN } from "@project-serum/anchor";
import {
  liquidateObligationInstruction,
  Port,
  PortProfile,
  refreshObligationInstruction,
  refreshReserveInstruction,
  ReserveContext,
  ReserveId,
  ReserveInfo,
} from "@port.finance/port-sdk";
import * as bs58 from "bs58";
import { EnrichedObligation, TokenAccountDetail } from "./types";
import { getUnhealthyObligations } from "./obligation";
import {
  LAMPORT_DECIMAL,
  LIQUIDATOR_REDUCE_FACTOR,
  portEnv,
  PORT_ENV,
  SOL_MINT as SOL_MINT_ID,
} from "./const";
import { redeemRemainingCollaterals } from "./redeem";
import {
  fetchStakingAccounts,
  fetchTokenAccount,
  prepareTokenAccounts,
} from "./account";
import { log } from "./infra/logger";
import { rebalanceCoins } from "./rebalance";
import { JupiterSwap } from "./infra/thrid/swap";

async function runLiquidator() {
  const clusterUrl = PORT_ENV.CLUSTER_URL;
  const checkInterval = PORT_ENV.CHECK_INTERVAL;
  const connection = new Connection(clusterUrl, "singleGossip");

  // The address of the Port Finance on the blockchain
  const programId = PORT_ENV.PROGRAM_ID;

  // liquidator's keypair
  const bs58KeyPair = PORT_ENV.KEYPAIR;
  const payer = Keypair.fromSecretKey(bs58.decode(bs58KeyPair));
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    preflightCommitment: "recent",
    commitment: "recent",
  });

  const portApi = Port.forMainNet({
    connection: connection,
  });
  log.common.info(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await portApi.getReserveContext();
  const assetContext = portEnv.getAssetContext();

  const wallets = await prepareTokenAccounts(provider, reserveContext);

  log.common.info(`wallet token account prepared`);
  while (true) {
    try {
      await rebalanceCoins(
        portApi,
        connection,
        await JupiterSwap.new(connection, payer),
        payer.publicKey
      );
    } catch (reason) {
      log.alert.warn(
        `rebalance failed with error: ${reason}, will skip and try it in next loop`
      );
    }

    try {
      log.common.info(`start fetching unhealthy obligations...`);
      const unhealthyObligations = await getUnhealthyObligations(connection);
      log.common.info(
        `payer account ${payer.publicKey.toBase58()}, we have ${
          unhealthyObligations.length
        } accounts for liquidation
`
      );

      for (const unhealthyObligation of unhealthyObligations) {
        log.common.warn(
          `Liquidating obligation account ${unhealthyObligation.obligation
            .getProfileId()
            .toString()} which is owned by ${unhealthyObligation.obligation
            .getOwner()
            ?.toBase58()} with risk factor: ${
            unhealthyObligation.riskFactor
          }, which has borrowed ${unhealthyObligation.totalLoanValue} ...`
        );

        try {
          await liquidateUnhealthyObligation(
            provider,
            programId,
            unhealthyObligation,
            reserveContext,
            wallets
          );

          await redeemRemainingCollaterals(
            provider,
            programId,
            assetContext,
            reserveContext,
            wallets
          );
        } catch (reason) {
          log.alert.info(`Liquidation failed: ${reason}`);
          continue;
        }
      }
    } catch (e) {
      log.alert.info(`unknown error: ${e}`);
    } finally {
      await sleep(checkInterval);
    }
    // break;
  }
}

async function liquidateUnhealthyObligation(
  provider: AnchorProvider,
  programId: PublicKey,
  obligation: EnrichedObligation,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccountDetail>
) {
  const payerAccount = await provider.connection.getAccountInfo(
    provider.wallet.publicKey
  );
  if (!payerAccount) {
    throw new Error(`No lamport for ${provider.wallet.publicKey}`);
  }

  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId();
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId
  );
  const instructions: TransactionInstruction[] = [];
  const signers: Keypair[] = [];

  const toRefreshReserves: Set<ReserveId> = new Set();
  obligation.obligation.getLoans().forEach((borrow) => {
    toRefreshReserves.add(borrow.getReserveId());
  });
  obligation.obligation.getCollaterals().forEach((deposit) => {
    toRefreshReserves.add(deposit.getReserveId());
  });
  toRefreshReserves.forEach((reserve) => {
    const reserveInfo = reserveContext.getReserve(reserve);
    instructions.push(
      refreshReserveInstruction(
        reserveInfo.getReserveId(),
        reserveInfo.getOracleId() ?? null
      )
    );
  });

  const loans = obligation.obligation.getLoans();
  const collaterals = obligation.obligation.getCollaterals();

  const repayLoan = loans.reduce((prev, cur) => {
    if (
      obligation.loanDetails[prev.getReserveId().toString()].value.gt(
        obligation.loanDetails[cur.getReserveId().toString()].value
      )
    ) {
      return prev;
    }
    return cur;
  });
  const repayReserve: ReserveInfo = reserveContext.getReserve(
    repayLoan.getReserveId()
  );
  const repayAmount = repayLoan.toU64();

  const withdrawCollateral = collaterals.reduce((prev, cur) => {
    if (
      obligation.depositDetails[prev.getReserveId().toString()].value.gt(
        obligation.depositDetails[cur.getReserveId().toString()].value
      )
    ) {
      return prev;
    }
    return cur;
  });
  const withdrawReserve = reserveContext.getReserve(
    withdrawCollateral.getReserveId()
  );

  if (
    repayReserve.getAssetMintId().toString() !== SOL_MINT_ID &&
    (!wallets.has(repayReserve.getAssetMintId().toString()) ||
      !wallets.has(withdrawReserve.getShareMintId().toString()))
  ) {
    throw Error(
      `No required wallet asset exists, required ${repayReserve
        .getAssetMintId()
        .toString()} and ${withdrawReserve.getShareMintId().toString()}`
    );
  }

  const repayWallet = wallets.get(repayReserve.getAssetMintId().toString());
  const withdrawWallet = wallets.get(
    withdrawReserve.getShareMintId().toString()
  );

  if (!repayWallet || !withdrawWallet) {
    throw new Error("no collateral wallet found");
  }
  const latestRepayWallet = await fetchTokenAccount(
    provider.connection,
    repayWallet.address
  );

  const assetContext = portEnv.getAssetContext();
  const repayTokenName = assetContext
    .findConfigByReserveId(repayReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();
  const withdrawTokenName = assetContext
    .findConfigByReserveId(withdrawReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();

  if (repayReserve.getAssetMintId().toString() !== SOL_MINT_ID) {
    const realAmount = u64.min(
      repayAmount,
      latestRepayWallet.amount
        .mul(new BN(LIQUIDATOR_REDUCE_FACTOR * 100))
        .div(new BN(100))
    );
    if (realAmount.lte(new u64(0))) {
      log.alert.warn(
        `liquidate by paying token, obligation ${obligation.obligation
          .getId()
          .toString()}, repay[${repayTokenName} with loan ${repayLoan
          .toU64()
          .toString()}], withdraw ${withdrawTokenName}: liquidate amount invalid ${realAmount.toString()}`
      );
      throw Error(
        `liquidate by paying token, repay[${repayTokenName} with loan ${repayLoan
          .toU64()
          .toString()}], withdraw ${withdrawTokenName}: liquidate amount invalid ${realAmount.toString()}`
      );
    }

    await liquidateByPayingToken(
      provider,
      instructions,
      realAmount,
      repayWallet.address,
      withdrawWallet.address,
      repayReserve,
      withdrawReserve,
      obligation.obligation,
      lendingMarket,
      lendingMarketAuthority,
      programId
    );
  } else {
    const availableAmount = new u64(payerAccount.lamports - LAMPORT_DECIMAL);
    const realAmount = repayAmount.gt(availableAmount)
      ? u64.min(repayAmount.div(new u64(2)).add(new u64(1)), availableAmount)
      : repayAmount;

    if (realAmount.lte(new u64(0))) {
      log.alert.warn(
        `liquidate by paying SOL, obligation ${obligation.obligation
          .getId()
          .toString()}: repay[${repayTokenName} with loan ${repayLoan
          .toU64()
          .toString()}], withdraw ${withdrawTokenName}: liquidate amount invalid ${realAmount.toString()}`
      );
      throw Error(
        `liquidate by paying SOL: liquidate amount invalid ${realAmount.toString()}`
      );
    }
    await liquidateByPayingSOL(
      provider,
      instructions,
      signers,
      realAmount,
      withdrawWallet.address,
      repayReserve,
      withdrawReserve,
      obligation.obligation,
      lendingMarket,
      lendingMarketAuthority,
      programId
    );
  }

  const liquidationSig = await sendTransaction(
    provider,
    instructions,
    signers,
    true
  ).catch((reason) => {
    log.alert.warn(
      `Liqudiation transaction sent failed: obligation ${obligation.obligation
        .getId()
        .toString()}, paying ${repayTokenName} for ${withdrawTokenName}, reason: ${reason}`
    );
    throw reason;
  });

  log.common.warn(
    `Liqudiation tx sent successfully: ${liquidationSig}, obligation ${obligation.obligation
      .getId()
      .toString()}, paying ${repayTokenName} for ${withdrawTokenName}.`
  );
}

async function liquidateByPayingSOL(
  provider: AnchorProvider,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  amount: u64,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortProfile,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  lendingProgramId: PublicKey
): Promise<void> {
  const wrappedSOLTokenAccount = new Keypair();
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: wrappedSOLTokenAccount.publicKey,
      lamports: amount.toNumber(),
      space: AccountLayout.span,
      programId: new PublicKey(TOKEN_PROGRAM_ID),
    }),
    Token.createInitAccountInstruction(
      new PublicKey(TOKEN_PROGRAM_ID),
      new PublicKey(SOL_MINT_ID),
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey
    )
  );

  await liquidateByPayingToken(
    provider,
    instructions,
    amount,
    wrappedSOLTokenAccount.publicKey,
    withdrawWallet,
    repayReserve,
    withdrawReserve,
    obligation,
    lendingMarket,
    lendingMarketAuthority,
    lendingProgramId
  );

  instructions.push(
    Token.createCloseAccountInstruction(
      TOKEN_PROGRAM_ID,
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      []
    )
  );

  signers.push(wrappedSOLTokenAccount);
}

async function liquidateByPayingToken(
  provider: AnchorProvider,
  instructions: TransactionInstruction[],
  amount: u64,
  repayWallet: PublicKey,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortProfile,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  lendingProgramId: PublicKey
): Promise<void> {
  const stakeAccounts = await fetchStakingAccounts(
    provider.connection,
    obligation.getOwner()!,
    withdrawReserve.getStakingPoolId()!
  );

  const laons = obligation.getLoans();
  const collaterals = obligation.getCollaterals();

  instructions.push(
    refreshObligationInstruction(
      obligation.getProfileId(),
      collaterals.map((deposit) => deposit.getReserveId()),
      laons.map((borrow) => borrow.getReserveId())
    ),
    liquidateObligationInstruction(
      amount,
      repayWallet,
      withdrawWallet,
      repayReserve.getReserveId(),
      repayReserve.getAssetBalanceId(),
      withdrawReserve.getReserveId(),
      withdrawReserve.getShareBalanceId(),
      obligation.getProfileId(),
      lendingMarket,
      lendingMarketAuthority,
      provider.wallet.publicKey,
      lendingProgramId,
      withdrawReserve.getStakingPoolId()
        ? withdrawReserve.getStakingPoolId()
        : undefined,
      withdrawReserve.getStakingPoolId() ? stakeAccounts[0].pubkey : undefined
    )
  );
}

runLiquidator();
