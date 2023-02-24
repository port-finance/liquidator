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
}
