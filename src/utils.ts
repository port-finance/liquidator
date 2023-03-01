import {
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { Provider } from "@project-serum/anchor";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export async function sendTransaction(
  provider: Provider,
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
