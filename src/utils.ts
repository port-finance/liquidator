import {
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction,
  AccountInfo,
  PublicKey,
  TransactionInstruction,
  ParsedAccountData,
} from "@solana/web3.js";
import { AnchorProvider, BN } from "@project-serum/anchor";
import {
  AccountInfo as TokenAccount,
  AccountLayout,
  u64,
} from "@solana/spl-token";
import { TokenAccountDetail } from "./types";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export async function sendTransaction(
  provider: AnchorProvider,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  confirm?: boolean
): Promise<string> {
  let transaction = new Transaction({ feePayer: provider.wallet.publicKey });

  instructions.forEach((instruction) => {
    transaction.add(instruction);
  });
  transaction.recentBlockhash = (
    await provider.connection.getLatestBlockhash("confirmed")
  ).blockhash;

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }

  transaction = await provider.wallet.signTransaction(transaction);
  const rawTransaction = transaction.serialize();
  const options = {
    skipPreflight: true,
    commitment: "confirmed",
  };

  if (!confirm) {
    return await provider.connection.sendRawTransaction(
      rawTransaction,
      options
    );
  } else {
    return await sendAndConfirmRawTransaction(
      provider.connection,
      rawTransaction
    );
  }
}

export const parseTokenAccountFromBuf = (
  info: AccountInfo<Buffer>,
  address: PublicKey
): TokenAccount => {
  const rawAccount = AccountLayout.decode(info.data);

  return {
    address,
    mint: new PublicKey(rawAccount.mint),
    owner: new PublicKey(rawAccount.owner),
    amount: u64.fromBuffer(rawAccount.amount),
    delegate:
      rawAccount.delegateOption === 0
        ? new PublicKey(rawAccount.delegate)
        : null,
    delegatedAmount:
      rawAccount.delegateOption === 0
        ? new u64(0)
        : u64.fromBuffer(rawAccount.delegatedAmount),
    // state enum: https://solana-labs.github.io/solana-program-library/token/js/enums/AccountState.html
    isInitialized: rawAccount.state !== 0,
    isFrozen: rawAccount.state === 2,
    isNative: !!rawAccount.isNativeOption,
    rentExemptReserve:
      rawAccount.isNativeOption === 1
        ? u64.fromBuffer(rawAccount.isNative)
        : null,
    closeAuthority: rawAccount.closeAuthorityOption
      ? new PublicKey(rawAccount.closeAuthority)
      : null,
  };
};

export const parseTokenAccount = (
  address: PublicKey,
  info: AccountInfo<ParsedAccountData>
): TokenAccountDetail => {
  const { data } = info;
  const detailInfo = data.parsed["info"];
  return {
    address,
    isNative: detailInfo["isNative"],
    mint: new PublicKey(detailInfo["mint"]),
    owner: new PublicKey(detailInfo["owner"]),
    state: detailInfo["state"],
    amount: new BN(detailInfo["tokenAmount"]["amount"]),
    tokenAmount: {
      amount: new BN(detailInfo["tokenAmount"]["amount"]),
      decimals: detailInfo["tokenAmount"]["decimals"],
      uiAmount: detailInfo["tokenAmount"]["uiAmount"],
      uiAmountString: detailInfo["tokenAmount"]["uiAmountString"],
    },
  };
};
