import Big from "big.js";
import { PortProfile } from "@port.finance/port-sdk";

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
