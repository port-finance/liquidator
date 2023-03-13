import {
  ReserveContext,
  ReserveInfo,
  refreshReserveInstruction,
  redeemReserveCollateralInstruction,
  AssetContext,
} from "@port.finance/port-sdk";
import { AnchorProvider, BN } from "@project-serum/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { sendTransaction } from "./utils";
import { fetchTokenAccount } from "./account";
import { log } from "./infra/logger";
import { TokenAccountDetail } from "./types";

export async function redeemRemainingCollaterals(
  provider: AnchorProvider,
  programId: PublicKey,
  assetCtx: AssetContext,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccountDetail>
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

    const withdrawTokenName = assetCtx
      .findConfigByReserveId(reserve.getReserveId())
      ?.getDisplayConfig()
      .getName();

    try {
      const collateralWallet = await fetchTokenAccount(
        provider.connection,
        collateralWalletPubkey.address
      );
      wallets.set(reserve.getShareMintId().toString(), collateralWallet);
      if (!collateralWallet.amount.isZero()) {
        const redeemSig = await redeemCollateral(
          provider,
          wallets,
          reserve,
          lendingMarketAuthority
        );
        log.common.warn(
          `Redeemed ${collateralWallet.amount.toString()} lamport of ${withdrawTokenName} collateral tokens: ${redeemSig}`
        );
      }
    } catch (e) {
      log.alert.info(e);
    }
  });
}

export async function redeemCollateral(
  provider: AnchorProvider,
  wallets: Map<string, TokenAccountDetail>,
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

  if (collateralWallet.amount.lte(new BN(0))) {
    throw new Error("No collateral asset found.");
  }

  instructions.push(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      collateralWallet.address,
      transferAuthority.publicKey,
      provider.wallet.publicKey,
      [],
      new u64(collateralWallet.amount.toString())
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
