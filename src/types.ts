import Big from "big.js";
import { PortProfile } from "@port.finance/port-sdk";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@project-serum/anchor";

export interface EnrichedObligation {
  riskFactor: number;
  // loan value in USD
  totalLoanValue: Big;
  // collateral value in USD
  totalLiquidationLoanValue: Big;
  obligation: PortProfile;
  loanAssetNames: string[];
  depositedAssetNames: string[];
  // ReserveId -> reserve detail
  loanDetails: Record<string, AssetDetail>;
  depositDetails: Record<string, AssetDetail>;
}

export interface AssetDetail {
  price: Big;
  value: Big;
  assetName: string;
}

export interface TokenAccountDetail {
  address: PublicKey;
  isNative: boolean;
  mint: PublicKey;
  owner: PublicKey;
  state: string;
  amount: BN;
  tokenAmount: {
    amount: BN;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}
