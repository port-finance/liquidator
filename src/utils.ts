import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import {
  AccountInfo,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { TransactionInstruction } from '@solana/web3.js';
import Big from 'big.js';
import { AccountInfo as TokenAccount } from '@solana/spl-token';
import { getTokenAccount, parseTokenAccount } from '@project-serum/common';
import { BN, Provider } from '@project-serum/anchor';

export const STAKING_PROGRAM_ID = new PublicKey(
  'stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq',
);
export const ZERO: Big = new Big(0);

export function notify(content: string) {
  if (process.env.WEBHOOK_URL) {
    axios.post(process.env.WEBHOOK_URL, { text: content });
  }
  console.log(content);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export async function findLargestTokenAccountForOwner(
  connection: Connection,
  owner: Keypair,
  mint: PublicKey,
): Promise<TokenAccount> {
  const response = await connection.getTokenAccountsByOwner(
    owner.publicKey,
    { mint },
    connection.commitment,
  );
  let max = new BN(0);
  let maxTokenAccount: TokenAccount | null = null;
  let maxPubkey: null | PublicKey = null;

  for (const { pubkey, account } of response.value) {
    const tokenAccount = parseTokenAccount(account.data);
    if (tokenAccount.amount.gt(max)) {
      maxTokenAccount = tokenAccount;
      max = tokenAccount.amount;
      maxPubkey = pubkey;
    }
  }

  if (maxPubkey && maxTokenAccount) {
    return maxTokenAccount;
  } else {
    console.log('creating new token account');
    const transaction = new Transaction();
    const aTokenAccountPubkey = (
      await PublicKey.findProgramAddress(
        [
          owner.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
    )[0];

    transaction.add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAccountPubkey,
        owner.publicKey,
        owner.publicKey,
      ),
    );
    await connection.sendTransaction(transaction, [owner]);
    return {
      address: aTokenAccountPubkey,
      owner: owner.publicKey,
      mint,
    } as TokenAccount;
  }
}

export async function getOwnedTokenAccounts(
  provider: Provider,
): Promise<TokenAccount[]> {
  const accounts = await provider.connection.getProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        {
          memcmp: {
            offset: AccountLayout.offsetOf('owner'),
            bytes: provider.wallet.publicKey.toBase58(),
          },
        },
        {
          dataSize: AccountLayout.span,
        },
      ],
    },
  );
  return accounts.map((r) => {
    const tokenAccount = parseTokenAccount(r.account.data);
    tokenAccount.address = r.pubkey;
    return tokenAccount;
  });
}

export async function fetchTokenAccount(
  provider: Provider,
  address: PublicKey,
): Promise<AccountInfo> {
  const tokenAccount = await getTokenAccount(provider, address);
  tokenAccount.address = address;
  return tokenAccount;
}

export async function createAssociatedTokenAccount(
  provider: Provider,
  mint: PublicKey,
): Promise<PublicKey> {
  const aTokenAddr = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mint,
    provider.wallet.publicKey,
  );
  console.log(`Creating token account for ${mint.toString()}`);
  await sendTransaction(
    provider,
    [
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAddr,
        provider.wallet.publicKey,
        provider.wallet.publicKey,
      ),
    ],
    [],
    true,
  );
  return aTokenAddr;
}

export async function sendTransaction(
  provider: Provider,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  confirm?: boolean,
): Promise<string> {
  let transaction = new Transaction({ feePayer: provider.wallet.publicKey });

  instructions.forEach((instruction) => {
    transaction.add(instruction);
  });
  transaction.recentBlockhash = (
    await provider.connection.getRecentBlockhash('singleGossip')
  ).blockhash;

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }

  transaction = await provider.wallet.signTransaction(transaction);
  const rawTransaction = transaction.serialize();
  const options = {
    skipPreflight: true,
    commitment: 'singleGossip',
  };

  if (!confirm) {
    return provider.connection.sendRawTransaction(rawTransaction, options);
  } else {
    return await sendAndConfirmRawTransaction(
      provider.connection,
      rawTransaction,
    );
  }
}

export function defaultTokenAccount(
  address: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TokenAccount {
  return {
    address,
    owner,
    mint,
    amount: new BN(0),
  } as TokenAccount;
}
