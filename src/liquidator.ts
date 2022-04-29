import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  AccountInfo,
  TransactionInstruction,
} from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import {
  createAssociatedTokenAccount,
  defaultTokenAccount,
  fetchTokenAccount,
  getOwnedTokenAccounts,
  notify,
  sendTransaction,
  sleep,
  STAKING_PROGRAM_ID,
  ZERO,
} from './utils';
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from '@solana/spl-token';
import { parsePriceData } from '@pythnetwork/client';
import Big from 'big.js';
import { SwitchboardAccountType } from '@switchboard-xyz/switchboard-api';
import { AccountInfo as TokenAccount } from '@solana/spl-token';
import { Provider, Wallet } from '@project-serum/anchor';
import {
  liquidateObligationInstruction,
  Port,
  Environment,
  PortProfile,
  redeemReserveCollateralInstruction,
  refreshObligationInstruction,
  refreshReserveInstruction,
  ReserveContext,
  ReserveId,
  ReserveInfo,
} from '@port.finance/port-sdk';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DISPLAY_FIRST = 20;

const portEnvironment = Environment.forMainNet();

interface EnrichedObligation {
  riskFactor: number;
  // loan value in USD
  loanValue: Big;
  // collateral value in USD
  collateralValue: Big;
  obligation: PortProfile;
  borrowedAssetNames: string[];
  depositedAssetNames: string[];
}

async function runLiquidator() {
  const clusterUrl =
    process.env.CLUSTER_URL || 'https://api.mainnet-beta.solana.com';
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || '8000.0');
  const connection = new Connection(clusterUrl, 'singleGossip');

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(
    process.env.PROGRAM_ID || 'Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR',
  );

  // liquidator's keypair
  const keyPairPath =
    process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8'))),
  );
  const provider = new Provider(connection, new Wallet(payer), {
    preflightCommitment: 'recent',
    commitment: 'recent',
  });

  console.log(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await Port.forMainNet({
    connection,
  }).getReserveContext();

  const wallets = await prepareTokenAccounts(provider, reserveContext);

  // eslint-disable-next-line
  while (true) {
    try {
      const unhealthyObligations = await getUnhealthyObligations(connection);
      console.log(
        `Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${
          unhealthyObligations.length
        } accounts for liquidation`,
      );
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
          `Liquidating obligation account ${unhealthyObligation.obligation
            .getProfileId()
            .toString()} which is owned by ${unhealthyObligation.obligation
            .getOwner()
            ?.toBase58()} with risk factor: ${unhealthyObligation.riskFactor}
which has borrowed ${unhealthyObligation.loanValue} ...
`,
        );
        await liquidateUnhealthyObligation(
          provider,
          programId,
          unhealthyObligation,
          reserveContext,
          wallets,
        );

        await redeemRemainingCollaterals(
          provider,
          programId,
          reserveContext,
          wallets,
        );
      }
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error('error: ', e);
    } finally {
      await sleep(checkInterval);
    }
    // break;
  }
}

async function prepareTokenAccounts(
  provider: Provider,
  reserveContext: ReserveContext,
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
        mintId,
      );
      wallets.set(
        mintId.toString(),
        defaultTokenAccount(aTokenAddress, provider.wallet.publicKey, mintId),
      );
    }
  }

  return wallets;
}

async function redeemRemainingCollaterals(
  provider: Provider,
  programId: PublicKey,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>,
) {
  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId();
  reserveContext.getAllReserves().forEach(async (reserve) => {
    const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
      [lendingMarket.toBuffer()],
      programId,
    );
    const collateralWalletPubkey = wallets.get(
      reserve.getShareMintId().toString(),
    );
    if (!collateralWalletPubkey) {
      throw new Error(
        `No collateral wallet for ${reserve.getShareMintId().toString()}`,
      );
    }

    try {
      const collateralWallet = await fetchTokenAccount(
        provider,
        collateralWalletPubkey.address,
      );
      wallets.set(reserve.getShareMintId().toString(), collateralWallet);
      if (!collateralWallet.amount.isZero()) {
        await redeemCollateral(
          provider,
          wallets,
          reserve,
          lendingMarketAuthority,
        );
      }
    } catch (e) {
      console.log(e);
    }
  });
}

async function readSymbolPrice(
  connection: Connection,
  reserve: ReserveInfo,
): Promise<Big> {
  const oracleId = reserve.getOracleId();
  if (oracleId) {
    const oracleData = await connection.getAccountInfo(oracleId);
    if (!oracleData) {
      throw new Error('cannot fetch account oracle data');
    }
    return parseOracleData(oracleData, reserve);
  }

  return reserve.getMarkPrice().getRaw();
}

const PYTH_PROGRAM = 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH';
const SWITCH_BOARD_PROGRAM = 'DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM';
function parseOracleData(
  accountInfo: AccountInfo<Buffer>,
  reserveInfo: ReserveInfo,
): Big {
  if (accountInfo.owner.toString() === PYTH_PROGRAM) {
    const parsedPythData = parsePriceData(accountInfo.data);
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

  throw Error('Unrecognized oracle account');
}

async function readTokenPrices(
  connection: Connection,
  reserveContext: ReserveContext,
): Promise<Map<string, Big>> {
  const tokenToCurrentPrice = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    tokenToCurrentPrice.set(
      reserve.getReserveId().toString(),
      await readSymbolPrice(connection, reserve),
    );
  }
  return tokenToCurrentPrice;
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

// eslint-disable-next-line
function getTotalShareTokenCollateralized(
  portBalances: PortProfile[],
): Map<string, Big> {
  const amounts = new Map();
  amounts.set('total_amount', new Big(0));

  portBalances.forEach((balance) => {
    amounts.set(
      'total_amount',
      amounts.get('total_amount').add(balance.getDepositedValue()),
    );
    balance.getCollaterals().forEach((collateral) => {
      const reserveId = collateral.getReserveId().toString();
      if (amounts.has(reserveId)) {
        amounts.set(
          reserveId,
          amounts.get(reserveId).add(collateral.getAmount().getRaw()), //TODO: Test
        );
      } else {
        amounts.set(reserveId, new Big(0));
      }
    });
  });
  return amounts;
}

async function getUnhealthyObligations(connection: Connection) {
  const mainnetPort = Port.forMainNet({});
  const portBalances = await mainnetPort.getAllPortProfiles();
  const reserves = await mainnetPort.getReserveContext();
  const tokenToCurrentPrice = await readTokenPrices(connection, reserves);
  const sortedObligations = portBalances
    .filter((obligation) => !isNoBorrow(obligation))
    .filter((obligation) => !willNeverLiquidate(obligation))
    .filter((obligation) => !isInsolvent(obligation))
    .map((obligation) =>
      generateEnrichedObligation(obligation, tokenToCurrentPrice, reserves),
    )
    .sort((obligation1, obligation2) => {
      return obligation2.riskFactor * 100 - obligation1.riskFactor * 100;
    });

  console.log(
    `
Total number of loans are ${portBalances.length} and possible liquidation debts are ${sortedObligations.length}
`,
  );
  sortedObligations.slice(0, DISPLAY_FIRST).forEach((ob) =>
    console.log(
      `Risk factor: ${ob.riskFactor.toFixed(4)} borrowed amount: ${
        ob.loanValue
      } deposit amount: ${ob.collateralValue}
borrowed asset names: [${ob.borrowedAssetNames.toString()}] deposited asset names: [${ob.depositedAssetNames.toString()}]
obligation pubkey: ${ob.obligation.getProfileId().toString()}
`,
    ),
  );

  tokenToCurrentPrice.forEach((price: Big, token: string) => {
    console.log(
      `name: ${portEnvironment
        .getAssetContext()
        .findConfigByReserveId(ReserveId.fromBase58(token))
        ?.getDisplayConfig()
        .getName()} price: ${price.toString()}`,
    );
  });
  console.log('\n');
  return sortedObligations.filter((obligation) => obligation.riskFactor >= 1);
}

function generateEnrichedObligation(
  obligation: PortProfile,
  tokenToCurrentPrice: Map<string, Big>,
  reserveContext: ReserveContext,
): EnrichedObligation {
  let totalLiquidationPrice = new Big(0);
  const loanAssetNames: string[] = [];
  const assetCtx = portEnvironment.getAssetContext();
  for (const loan of obligation.getLoans()) {
    const reservePubKey = loan.getReserveId().toString();
    const name = assetCtx
      .findConfigByReserveId(ReserveId.fromBase58(reservePubKey))
      ?.getDisplayConfig()
      .getSymbol();
    const reserve = reserveContext.getReserve(loan.getReserveId());
    const tokenPrice: Big | undefined = tokenToCurrentPrice.get(reservePubKey);
    if (!tokenPrice) {
      throw new Error('token price not found');
    }

    const liquidationPrice = loan
      .accrueInterest(reserve.asset.getCumulativeBorrowRate())
      .getRaw()
      .mul(tokenPrice)
      .div(reserve.getQuantityContext().multiplier); //TODO: test
    totalLiquidationPrice = totalLiquidationPrice.add(liquidationPrice);
    loanAssetNames.push(name ?? 'unknown');
  }
  let collateralValue: Big = new Big(0);
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
      throw new Error('error in token price or exchange ratio');
    }
    const totalPrice = deposit
      .getRaw()
      .div(exchangeRatio.getRaw())
      .mul(tokenPrice)
      .mul(liquidationThreshold)
      .div(reserve.getQuantityContext().multiplier); // TODO: test
    collateralValue = collateralValue.add(totalPrice);
    depositedAssetNames.push(name ?? 'unknown');
  }

  const riskFactor: number =
    collateralValue.eq(ZERO) || totalLiquidationPrice.eq(ZERO)
      ? 0
      : totalLiquidationPrice.div(collateralValue).toNumber();

  return {
    loanValue: totalLiquidationPrice,
    collateralValue,
    riskFactor,
    obligation,
    borrowedAssetNames: loanAssetNames,
    depositedAssetNames,
  };
}

async function liquidateUnhealthyObligation(
  provider: Provider,
  programId: PublicKey,
  obligation: EnrichedObligation,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>,
) {
  const payerAccount = await provider.connection.getAccountInfo(
    provider.wallet.publicKey,
  );
  if (!payerAccount) {
    throw new Error(`No lamport for ${provider.wallet.publicKey}`);
  }

  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId();
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
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
        reserveInfo.getOracleId() ?? null,
      ),
    );
  });

  const loans = obligation.obligation.getLoans();
  const collaterals = obligation.obligation.getCollaterals();
  let repayReserveId: ReserveId | null = null;

  for (const loan of loans) {
    const reserve = reserveContext.getReserve(loan.getReserveId());

    if (
      reserve.getAssetMintId().toString() === SOL_MINT && //TODO: test
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
        .toString()}`,
    );
  }

  const repayReserve: ReserveInfo = reserveContext.getReserve(repayReserveId);
  // TODO: choose a smarter way to withdraw collateral
  const withdrawReserve: ReserveInfo = reserveContext.getReserve(
    collaterals[0].getReserveId(),
  );

  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (
    repayReserve.getAssetMintId().toString() !== SOL_MINT &&
    (!wallets.has(repayReserve.getAssetMintId().toString()) ||
      !wallets.has(withdrawReserve.getShareMintId().toString()))
  ) {
    return;
  }

  const repayWallet = wallets.get(repayReserve.getAssetMintId().toString());
  const withdrawWallet = wallets.get(
    withdrawReserve.getShareMintId().toString(),
  );

  if (!repayWallet || !withdrawWallet) {
    throw new Error('no collateral wallet found');
  }
  const latestRepayWallet = await fetchTokenAccount(
    provider,
    repayWallet.address,
  );

  if (repayReserve.getAssetMintId().toString() !== SOL_MINT) {
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
      lendingMarketAuthority,
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
      lendingMarketAuthority,
    );
  }

  const liquidationSig = await sendTransaction(provider, instructions, signers);
  const assetContext = portEnvironment.getAssetContext();
  const repayTokenName = assetContext
    .findConfigByReserveId(repayReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();
  const withdrawTokenName = assetContext
    .findConfigByReserveId(withdrawReserve.getReserveId())
    ?.getDisplayConfig()
    .getName();
  console.log(
    `Liqudiation transaction sent: ${liquidationSig}, paying ${repayTokenName} for ${withdrawTokenName}.`,
  );

  const latestCollateralWallet = await fetchTokenAccount(
    provider,
    withdrawWallet.address,
  );
  wallets.set(
    withdrawReserve.getShareMintId().toString(),
    latestCollateralWallet,
  );
  const redeemSig = await redeemCollateral(
    provider,
    wallets,
    withdrawReserve,
    lendingMarketAuthority,
  );

  console.log(
    `Redeemed ${latestCollateralWallet.amount.toString()} lamport of ${withdrawTokenName} collateral tokens: ${redeemSig}`,
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
  lendingMarketAuthority: PublicKey,
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
      new PublicKey(SOL_MINT),
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey,
    ),
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
  );

  instructions.push(
    Token.createCloseAccountInstruction(
      TOKEN_PROGRAM_ID,
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      [],
    ),
  );

  signers.push(wrappedSOLTokenAccount);
}

async function fetchStakingAccounts(
  connection: Connection,
  owner: PublicKey,
  stakingPool: PublicKey | null,
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
  lendingMarketAuthority: PublicKey,
): Promise<void> {
  const stakeAccounts = await fetchStakingAccounts(
    provider.connection,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    obligation.getOwner()!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    withdrawReserve.getStakingPoolId()!,
  );

  const laons = obligation.getLoans();
  const collaterals = obligation.getCollaterals();

  instructions.push(
    refreshObligationInstruction(
      obligation.getProfileId(),
      collaterals.map((deposit) => deposit.getReserveId()),
      laons.map((borrow) => borrow.getReserveId()),
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
        : undefined,
    ),
  );
}

async function redeemCollateral(
  provider: Provider,
  wallets: Map<string, TokenAccount>,
  withdrawReserve: ReserveInfo,
  lendingMarketAuthority: PublicKey,
): Promise<string> {
  const instructions: TransactionInstruction[] = [];
  const transferAuthority = new Keypair();

  const collateralWallet = wallets.get(
    withdrawReserve.getShareMintId().toString(),
  );
  const liquidityWallet = wallets.get(
    withdrawReserve.getAssetMintId().toString(),
  );

  if (!collateralWallet || !liquidityWallet) {
    throw new Error('No collateral or liquidity wallet found.');
  }

  instructions.push(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      collateralWallet.address,
      transferAuthority.publicKey,
      provider.wallet.publicKey,
      [],
      collateralWallet.amount,
    ),
    refreshReserveInstruction(
      withdrawReserve.getReserveId(),
      withdrawReserve.getOracleId() ?? null,
    ),
    redeemReserveCollateralInstruction(
      collateralWallet.amount,
      collateralWallet.address,
      liquidityWallet.address,
      withdrawReserve.getReserveId(),
      withdrawReserve.getShareMintId(),
      withdrawReserve.getAssetBalanceId(),
      withdrawReserve.getMarketId(),
      lendingMarketAuthority,
      transferAuthority.publicKey,
    ),
  );

  const redeemSig = await sendTransaction(provider, instructions, [
    transferAuthority,
  ]);
  return redeemSig;
}

// eslint-disable-next-line
async function _sellToken(_tokenAccount: Wallet) {
  // TODO: sell token using Serum or Raydium
}

runLiquidator();
