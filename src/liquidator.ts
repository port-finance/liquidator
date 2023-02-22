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
import Big from "big.js";
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
import { portEnv, SOL_MINT as SOL_MINT_ID, STAKING_PROGRAM_ID } from "./const";
import { redeemCollateral, redeemRemainingCollaterals } from "./redeem";

async function runLiquidator() {
  // const clusterUrl =
  //   process.env.CLUSTER_URL || "https://api.mainnet-beta.solana.com";
  const clusterUrl =
    process.env.CLUSTER_URL ||
    "https://port-finance.rpcpool.com/385f15db-1967-4777-a05e-3c0ad9afd955";
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "8000.0");
  const connection = new Connection(clusterUrl, "singleGossip");

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(
    process.env.PROGRAM_ID || "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR"
  );

  // liquidator's keypair
  const keyPairPath =
    process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`;
  const bs58KeyPair = JSON.parse(
    fs.readFileSync(keyPairPath, "utf-8")
  ) as string;

  console.log(`length: ${bs58.decode(bs58KeyPair)}`);
  const payer = Keypair.fromSecretKey(bs58.decode(bs58KeyPair));

  const provider = new Provider(connection, new Wallet(payer), {
    preflightCommitment: "recent",
    commitment: "recent",
  });

  const portApi = Port.forMainNet({ connection: connection });
  console.log(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await portApi.getReserveContext();

  const wallets = await prepareTokenAccounts(provider, reserveContext);

  while (true) {
    try {
      console.log("begain liquidate process");
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
            ?.toBase58()} with risk factor: ${unhealthyObligation.riskFactor}
which has borrowed ${unhealthyObligation.totalLoanValue} ...
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

// eslint-disable-next-line
function getTotalShareTokenCollateralized(
  portBalances: PortProfile[]
): Map<string, Big> {
  const amounts = new Map();
  amounts.set("total_amount", new Big(0));

  portBalances.forEach((balance) => {
    amounts.set(
      "total_amount",
      amounts.get("total_amount").add(balance.getDepositedValue())
    );
    balance.getCollaterals().forEach((collateral) => {
      const reserveId = collateral.getReserveId().toString();
      if (amounts.has(reserveId)) {
        amounts.set(
          reserveId,
          amounts.get(reserveId).add(collateral.getAmount().getRaw()) //TODO: Test
        );
      } else {
        amounts.set(reserveId, new Big(0));
      }
    });
  });
  return amounts;
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
  let repayReserveId: ReserveId | null = null;

  for (const loan of loans) {
    const reserve = reserveContext.getReserve(loan.getReserveId());

    if (
      reserve.getAssetMintId().toString() === SOL_MINT_ID && //TODO: test
      payerAccount.lamports > 0
    ) {
      repayReserveId = loan.getReserveId();
      break;
    }

    const tokenWallet = wallets.get(reserve.getAssetMintId().toString()); // TODO: test
    if (!tokenWallet?.amount.isZero()) {
      repayReserveId = loan.getReserveId();
      break;
    }
  }

  if (repayReserveId === null) {
    throw new Error(
      `No token to repay at risk obligation: ${obligation.obligation
        .getId()
        .toString()}`
    );
  }

  const repayReserve: ReserveInfo = reserveContext.getReserve(repayReserveId);
  // TODO: choose a smarter way to withdraw collateral
  const withdrawReserve: ReserveInfo = reserveContext.getReserve(
    collaterals[0].getReserveId()
  );

  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (
    repayReserve.getAssetMintId().toString() !== SOL_MINT_ID &&
    (!wallets.has(repayReserve.getAssetMintId().toString()) ||
      !wallets.has(withdrawReserve.getShareMintId().toString()))
  ) {
    return;
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
    await liquidateByPayingToken(
      provider,
      instructions,
      latestRepayWallet.amount,
      repayWallet.address,
      withdrawWallet.address,
      repayReserve,
      withdrawReserve,
      obligation.obligation,
      lendingMarket,
      lendingMarketAuthority
    );
  } else {
    await liquidateByPayingSOL(
      provider,
      instructions,
      signers,
      new u64(payerAccount.lamports - 100_000_000),
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    obligation.getOwner()!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
