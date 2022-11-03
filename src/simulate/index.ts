import { Percentage } from '@port.finance/port-sdk';
import { Connection } from '@solana/web3.js';
import { getUnhealthyObligations } from '../liquidator';
// in "{ "PoRTjZMPXb9T7dyU7tpLEZRQj7e6ssfAE62j2oQuc6y": 100 }" alike format
import OVERRIDE from './threshold_override.json';

const thresholdOverride = new Map(
  Object.entries(OVERRIDE as Record<string, number>).map(([k, v]) => [
    k,
    Percentage.fromHundredBased(v),
  ]),
);

(async function main() {
  const clusterUrl = 'https://port-finance.rpcpool.com';
  const connection = new Connection(clusterUrl, {
    httpHeaders: {
      authority: 'port-finance.rpcpool.com',
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'zh,zh-CN;q=0.9',
      'content-type': 'application/json',
      origin: 'https://mainnet.port.finance',
      referer: 'https://mainnet.port.finance/',
      'sec-ch-ua':
        '"Not_A Brand";v="99", "Google Chrome";v="109", "Chromium";v="109"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    },
    commitment: 'singleGossip',
    // fetchMiddleware: console.log,
  });
  console.log('Simulating unhealthy profiles with override:');
  console.log(JSON.stringify(OVERRIDE, null, 2));
  const unhealthyObligations = await getUnhealthyObligations(
    connection,
    thresholdOverride,
  );
  console.log(`Total liquidate-able profiles: ${unhealthyObligations.length}`);
  unhealthyObligations.slice(0, 20).forEach((ob) =>
    console.log(
      `Risk factor: ${ob.riskFactor.toFixed(4)}
       borrowed amount: ${ob.loanValue} 
       deposit amount: ${ob.collateralValue}
       borrowed asset names: [${ob.borrowedAssetNames.toString()}]
       deposited asset names: [${ob.depositedAssetNames.toString()}]
       obligation pubkey: ${ob.obligation.getProfileId().toString()}`,
    ),
  );
})();
