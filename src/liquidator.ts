import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  AccountInfo,
  TransactionInstruction,
} from "@solana/web3.js";
import { homedir } from "os";
import * as fs from "fs";
import {
  createAssociatedTokenAccount,
  defaultTokenAccount,
  fetchTokenAccount,
  getOwnedTokenAccounts,
  notify,
  sendTransaction,
  sleep,
} from "./utils";
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { AccountInfo as TokenAccount } from "@solana/spl-token";
import { Provider, Wallet } from "@project-serum/anchor";
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
import { EnrichedObligation } from "./types";
import { getUnhealthyObligations } from "./obligation";
import {
  LAMPORT_DECIMAL,
  LIQUIDATOR_REDUCE_FACTOR,
  portEnv,
  PORT_ENV,
  SOL_MINT as SOL_MINT_ID,
  STAKING_PROGRAM_ID,
} from "./const";
import { redeemCollateral, redeemRemainingCollaterals } from "./redeem";

async function runLiquidator() {
  const clusterUrl = PORT_ENV.CLUSTER_URL;
  const checkInterval = PORT_ENV.CHECK_INTERVAL;
  const connection = new Connection(clusterUrl, "singleGossip");

  // The address of the Port Finance on the blockchain
  const programId = PORT_ENV.PROGRAM_ID;

  // liquidator's keypair
  const bs58KeyPair = PORT_ENV.KEYPAIR;
  const payer = Keypair.fromSecretKey(bs58.decode(bs58KeyPair));
  const provider = new Provider(connection, new Wallet(payer), {
    preflightCommitment: "recent",
    commitment: "recent",
  });

  const portApi = Port.forMainNet({
    connection: connection,
  });
  console.log(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await portApi.getReserveContext();

  const wallets = await prepareTokenAccounts(provider, reserveContext);

  while (true) {
    try {
      console.log(`start fetching unhealthy obligations...`);
      const unhealthyObligations = await getUnhealthyObligations(connection);
      console.log(
        `Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${
          unhealthyObligations.length
        } accounts for liquidation`
      );
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
          `Liquidating obligation account ${unhealthyObligation.obligation
            .getProfileId()
            .toString()} which is owned by ${unhealthyObligation.obligation
            .getOwner()
            ?.toBase58()} with risk factor: ${
            unhealthyObligation.riskFactor
          }, which has borrowed ${unhealthyObligation.totalLoanValue} ...
`
        );
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
          reserveContext,
          wallets
        );
      }
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error("error: ", e);
    } finally {
      await sleep(checkInterval);
    }
    // break;
  }
}

async function prepareTokenAccounts(
  provider: Provider,
  reserveContext: ReserveContext
): Promise<Map<string, TokenAccount>> {
  const wallets: Map<string, TokenAccount> = new Map<string, TokenAccount>();

  const tokenAccounts = await getOwnedTokenAccounts(provider);
  for (const tokenAccount of tokenAccounts) {
    wallets.set(tokenAccount.mint.toString(), tokenAccount);
  }

  const mintIds: PublicKey[] = reserveContext
    .getAllReserves()
    .flatMap((reserve) => [reserve.getAssetMintId(), reserve.getShareMintId()]);

  for (const mintId of mintIds) {
    if (!wallets.has(mintId.toString())) {
      const aTokenAddress = await createAssociatedTokenAccount(
        provider,
        mintId
      );
      wallets.set(
        mintId.toString(),
        defaultTokenAccount(aTokenAddress, provider.wallet.publicKey, mintId)
      );
    }
  }

  return wallets;
}

async function liquidateUnhealthyObligation(
  provider: Provider,
  programId: PublicKey,
  obligation: EnrichedObligation,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>
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
    if (prev.getAmount().gt(cur.getAmount())) {
      return prev;
    }
    return cur;
  });
  const repayReserve: ReserveInfo = reserveContext.getReserve(
    repayLoan.getReserveId()
  );
  const repayAmount = repayLoan.toU64();

  const withdrawCollateral = collaterals.reduce((prev, cur) => {
    if (prev.getAmount().gt(cur.getAmount())) {
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
      `No required wallet exists, required ${repayReserve
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
    provider,
    repayWallet.address
  );

  if (repayReserve.getAssetMintId().toString() !== SOL_MINT_ID) {
    const realAmount = u64.min(
      repayAmount,
      latestRepayWallet.amount.mul(new u64(LIQUIDATOR_REDUCE_FACTOR))
    );
    if (realAmount.lte(new u64(0))) {
      throw Error(
        `liquidate by paying token: liquidate amount invalid ${realAmount.toString()}`
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
      lendingMarketAuthority
    );
  } else {
    const availableAmount = new u64(payerAccount.lamports - LAMPORT_DECIMAL);
    const realAmount = repayAmount.gt(availableAmount)
      ? u64.min(repayAmount.div(new u64(2)).add(new u64(1)), availableAmount)
      : repayAmount;

    if (realAmount.lte(new u64(0))) {
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
      lendingMarketAuthority
    );
  }

  const liquidationSig = await sendTransaction(provider, instructions, signers);
  const assetContext = portEnv.getAssetContext();
  const repayTokenName = assetContext
    .findConfigByReserveId(repayReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();
  const withdrawTokenName = assetContext
    .findConfigByReserveId(withdrawReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();
  console.log(
    `Liqudiation transaction sent: ${liquidationSig}, paying ${repayTokenName} for ${withdrawTokenName}.`
  );

  const latestCollateralWallet = await fetchTokenAccount(
    provider,
    withdrawWallet.address
  );
  wallets.set(
    withdrawReserve.getShareMintId().toString(),
    latestCollateralWallet
  );
  const redeemSig = await redeemCollateral(
    provider,
    wallets,
    withdrawReserve,
    lendingMarketAuthority
  );

  console.log(
    `Redeemed ${latestCollateralWallet.amount.toString()} lamport of ${withdrawTokenName} collateral tokens: ${redeemSig}`
  );
}

async function liquidateByPayingSOL(
  provider: Provider,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  amount: u64,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortProfile,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey
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
    lendingMarketAuthority
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

async function fetchStakingAccounts(
  connection: Connection,
  owner: PublicKey,
  stakingPool: PublicKey | null
): Promise<
  Array<{
    pubkey: PublicKey;
    account: AccountInfo<Buffer>;
  }>
> {
  if (stakingPool === null) {
    return [];
  }
  return await connection.getProgramAccounts(STAKING_PROGRAM_ID, {
    filters: [
      {
        dataSize: 233,
      },
      {
        memcmp: {
          offset: 1 + 16,
          bytes: owner.toBase58(),
        },
      },
      {
        memcmp: {
          offset: 1 + 16 + 32,
          bytes: stakingPool.toBase58(),
        },
      },
    ],
  });
}

async function liquidateByPayingToken(
  provider: Provider,
  instructions: TransactionInstruction[],
  amount: u64,
  repayWallet: PublicKey,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortProfile,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey
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
      withdrawReserve.getStakingPoolId() !== null
        ? withdrawReserve.getStakingPoolId()
        : undefined,
      withdrawReserve.getStakingPoolId() !== null
        ? stakeAccounts[0].pubkey
        : undefined
    )
  );
}

runLiquidator();
