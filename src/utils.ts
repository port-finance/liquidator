import {
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction,
  AccountInfo,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { AnchorProvider } from "@project-serum/anchor";
import {
  AccountInfo as TokenAccount,
  AccountLayout,
  u64,
} from "@solana/spl-token";

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
    await provider.connection.getRecentBlockhash("singleGossip")
  ).blockhash;

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }

  transaction = await provider.wallet.signTransaction(transaction);
  const rawTransaction = transaction.serialize();
  const options = {
    skipPreflight: true,
    commitment: "singleGossip",
  };

  if (!confirm) {
    return provider.connection.sendRawTransaction(rawTransaction, options);
  } else {
    return await sendAndConfirmRawTransaction(
      provider.connection,
      rawTransaction
    );
  }
}

export const parseTokenAccount = (
  info: AccountInfo<Buffer>,
  address: PublicKey
): TokenAccount => {
  const rawAccount = AccountLayout.decode(info.data);

  return {
    address,
    mint: new PublicKey(rawAccount.mint),
    owner: new PublicKey(rawAccount.owner),
    amount: u64.fromBuffer(rawAccount.amount),
    delegate: rawAccount.delegateOption === 0 ? rawAccount.delegate : null,
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
