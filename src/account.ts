import { Provider, BN } from "@project-serum/anchor";
import { ReserveContext } from "@port.finance/port-sdk";
import { getTokenAccount, parseTokenAccount } from "@project-serum/common";
import {
  AccountInfo as TokenAccount,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  Connection,
  AccountInfo,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import { STAKING_PROGRAM_ID } from "./const";
import { sendTransaction } from "./utils";
import { log } from "./infra/logger";

export async function prepareTokenAccounts(
  provider: Provider,
  reserveContext: ReserveContext
): Promise<Map<string, TokenAccount>> {
  const wallets: Map<string, TokenAccount> = new Map<string, TokenAccount>();

  const tokenAccounts = await getOwnedTokenAccounts(
    provider.connection,
    provider.wallet.publicKey
  );
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

export async function fetchStakingAccounts(
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

export async function findLargestTokenAccountForOwner(
  connection: Connection,
  owner: Keypair,
  mint: PublicKey
): Promise<TokenAccount> {
  const response = await connection.getTokenAccountsByOwner(
    owner.publicKey,
    { mint },
    connection.commitment
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
    log.common.info(`creating new token account...`);

    const transaction = new Transaction();
    const aTokenAccountPubkey = (
      await PublicKey.findProgramAddress(
        [
          owner.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    )[0];

    transaction.add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAccountPubkey,
        owner.publicKey,
        owner.publicKey
      )
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
  conn: Connection,
  walllet: PublicKey
): Promise<TokenAccount[]> {
  const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: AccountLayout.offsetOf("owner"),
          bytes: walllet.toBase58(),
        },
      },
      {
        dataSize: AccountLayout.span,
      },
    ],
  });
  return accounts.map((r) => {
    const tokenAccount = parseTokenAccount(r.account.data);
    tokenAccount.address = r.pubkey;
    return tokenAccount;
  });
}

export async function fetchTokenAccount(
  provider: Provider,
  address: PublicKey
): Promise<TokenAccount> {
  const tokenAccount = await getTokenAccount(provider, address);
  tokenAccount.address = address;
  return tokenAccount;
}

export async function createAssociatedTokenAccount(
  provider: Provider,
  mint: PublicKey
): Promise<PublicKey> {
  const aTokenAddr = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mint,
    provider.wallet.publicKey
  );
  log.common.info(`Creating token account for ${mint.toString()}`);
  await sendTransaction(
    provider,
    [
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAddr,
        provider.wallet.publicKey,
        provider.wallet.publicKey
      ),
    ],
    [],
    true
  );
  return aTokenAddr;
}

export function defaultTokenAccount(
  address: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TokenAccount {
  return {
    address,
    owner,
    mint,
    amount: new BN(0),
  } as TokenAccount;
}
