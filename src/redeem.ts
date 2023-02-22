import {
  ReserveContext,
  ReserveInfo,
  refreshReserveInstruction,
  redeemReserveCollateralInstruction,
} from "@port.finance/port-sdk";
import { Provider } from "@project-serum/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AccountInfo as TokenAccount,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchTokenAccount, sendTransaction } from "./utils";

export async function redeemRemainingCollaterals(
  provider: Provider,
  programId: PublicKey,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>
) {
  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId();
  reserveContext.getAllReserves().forEach(async (reserve) => {
    const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
      [lendingMarket.toBuffer()],
      programId
    );
    const collateralWalletPubkey = wallets.get(
      reserve.getShareMintId().toString()
    );
    if (!collateralWalletPubkey) {
      throw new Error(
        `No collateral wallet for ${reserve.getShareMintId().toString()}`
      );
    }

    try {
      const collateralWallet = await fetchTokenAccount(
        provider,
        collateralWalletPubkey.address
      );
      wallets.set(reserve.getShareMintId().toString(), collateralWallet);
      if (!collateralWallet.amount.isZero()) {
        await redeemCollateral(
          provider,
          wallets,
          reserve,
          lendingMarketAuthority
        );
      }
    } catch (e) {
      console.log(e);
    }
  });
}

export async function redeemCollateral(
  provider: Provider,
  wallets: Map<string, TokenAccount>,
  withdrawReserve: ReserveInfo,
  lendingMarketAuthority: PublicKey
): Promise<string> {
  const instructions: TransactionInstruction[] = [];
  const transferAuthority = new Keypair();

  const collateralWallet = wallets.get(
    withdrawReserve.getShareMintId().toString()
  );
  const liquidityWallet = wallets.get(
    withdrawReserve.getAssetMintId().toString()
  );

  if (!collateralWallet || !liquidityWallet) {
    throw new Error("No collateral or liquidity wallet found.");
  }

  instructions.push(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      collateralWallet.address,
      transferAuthority.publicKey,
      provider.wallet.publicKey,
      [],
      collateralWallet.amount
    ),
    refreshReserveInstruction(
      withdrawReserve.getReserveId(),
      withdrawReserve.getOracleId() ?? null
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
      transferAuthority.publicKey
    )
  );

  const redeemSig = await sendTransaction(provider, instructions, [
    transferAuthority,
  ]);
  return redeemSig;
}
