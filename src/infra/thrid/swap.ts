import JSBI from "jsbi";
import { Connection, PublicKey } from "@solana/web3.js";
import { Jupiter, TOKEN_LIST_URL, TransactionError } from "@jup-ag/core";
import Big from "big.js";

export interface Token {
  chainId: number; // 101,
  address: string; // 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: string; // 'USDC',
  name: string; // 'Wrapped USDC',
  decimals: number; // 6,
  logoURI: string; // 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/BXXkv6z8ykpG1yuvUDPgh732wzVHB69RnB9YgSYh3itW/logo.png',
  tags: string[]; // [ 'stablecoin' ]
}

export class JupiterSwap {
  private tokens: Token[];
  private jupiter: Awaited<ReturnType<typeof Jupiter.load>>;
  private routeMap: Map<string, string[]>;

  static async new(conn: Connection, wallet: PublicKey) {
    const o = new JupiterSwap();
    await o.init(conn, wallet);
    return o;
  }

  private async init(conn: Connection, wallet: PublicKey) {
    // this.tokens = await (await fetch(TOKEN_LIST_URL["mainnet-beta"])).json();
    this.jupiter = await Jupiter.load({
      connection: conn,
      cluster: "mainnet-beta",
      user: wallet, // or public key
      // platformFeeAndAccounts:  NO_PLATFORM_FEE,
      // routeCacheDuration: CACHE_DURATION_MS
      // wrapUnwrapSOL: true (default) | false
    });
    // this.routeMap = this.jupiter.getRouteMap();
  }

  async swapWithBestRoute(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAmount: Big,
    slippageBps: number
  ) {
    const routes = await this.jupiter.computeRoutes({
      inputMint: inputMint,
      outputMint: outputMint,
      amount: JSBI.BigInt(inputAmount.toString()),
      slippageBps, // 1 bps = 0.01%.
      // forceFetch (optional) => to force fetching routes and not use the cache.
      // intermediateTokens => if provided will only find routes that use the intermediate tokens.
      // feeBps => the extra fee in BPS you want to charge on top of this swap.
      // onlyDirectRoutes =>  Only show single hop routes.
      // swapMode => "ExactIn" | "ExactOut" Defaults to "ExactIn"  "ExactOut" is to support use cases like payments when you want an exact output amount.
      // enforceSingleTx =>  Only show routes where only one single transaction is used to perform the Jupiter swap.
    });

    if (routes.routesInfos.length <= 0) {
      throw Error(
        `jupiter swap, routes is none, input=${outputMint.toString()}, output=${outputMint.toString()}`
      );
    }

    const bestRoute = routes.routesInfos[0];
    const { execute } = await this.jupiter.exchange({
      routeInfo: bestRoute,
    });

    // Execute swap
    const swapResult = await execute();

    if (swapResult["error"]) {
      const res = swapResult as { error: TransactionError };
      throw Error(`Jupiter swap failed: ${res.error}`);
    } else {
      const res = swapResult as {
        txid: string;
        inputAddress: PublicKey;
        outputAddress: PublicKey;
        inputAmount: number;
        outputAmount: number;
      };
      return res;
    }
  }
}
