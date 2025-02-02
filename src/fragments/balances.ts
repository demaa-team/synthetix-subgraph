import { Address, BigDecimal, BigInt, log } from '@graphprotocol/graph-ts';
import {
  Synth as SynthContract,
  Transfer as SynthTransferEvent,
} from '../../generated/subgraphs/balances/balances_SynthsUSD_0/Synth';

import { Synth, SynthBalance, LatestSynthBalance, SynthByCurrencyKey } from '../../generated/subgraphs/balances/schema';
import { FEE_ADDRESS, toDecimal, ZERO, ZERO_ADDRESS } from '../lib/helpers';

export function registerSynth(synthAddress: Address): void {
  // the address associated with the issuer may not be the proxy
  let synthBackContract = SynthContract.bind(synthAddress);
  let proxyQuery = synthBackContract.try_proxy();
  let nameQuery = synthBackContract.try_name();
  let symbolQuery = synthBackContract.try_symbol();

  if (symbolQuery.reverted) {
    log.warning('tried to save invalid synth {}', [synthAddress.toHex()]);
    return;
  }

  if (!proxyQuery.reverted) {
    synthAddress = proxyQuery.value;
  }

  let newSynth = new Synth(synthAddress.toHex());
  newSynth.name = nameQuery.reverted ? symbolQuery.value : nameQuery.value;
  newSynth.symbol = symbolQuery.value;
  newSynth.save();

  // symbol is same as currencyKey
  let newSynthByCurrencyKey = new SynthByCurrencyKey(symbolQuery.value);
  newSynthByCurrencyKey.proxyAddress = synthAddress;
  newSynthByCurrencyKey.save();

  // legacy sUSD contract uses wrong name
  if (symbolQuery.value == 'nUSD') {
    let newSynthByCurrencyKey = new SynthByCurrencyKey('sUSD');
    newSynthByCurrencyKey.proxyAddress = synthAddress;
    newSynthByCurrencyKey.save();
  }
}

function trackSynthHolder(synthAddress: Address, account: Address, timestamp: BigInt, value: BigDecimal): void {
  let synth = Synth.load(synthAddress.toHex());

  if (synth == null) {
    registerSynth(synthAddress);
  }

  let totalBalance = toDecimal(ZERO);
  let latestBalanceID = account.toHex() + '-' + synthAddress.toHex();
  let oldSynthBalance = LatestSynthBalance.load(latestBalanceID);

  if (oldSynthBalance == null || oldSynthBalance.timestamp.equals(timestamp)) {
    totalBalance = toDecimal(SynthContract.bind(synthAddress).balanceOf(account));
  } else {
    totalBalance = oldSynthBalance.amount.plus(value);
  }

  let newLatestBalance = new LatestSynthBalance(latestBalanceID);
  newLatestBalance.address = account;
  newLatestBalance.account = account.toHex();
  newLatestBalance.timestamp = timestamp;
  newLatestBalance.synth = synthAddress.toHex();
  newLatestBalance.amount = totalBalance;
  newLatestBalance.save();

  let newBalanceID = timestamp.toString() + '-' + account.toHex() + '-' + synthAddress.toHex();
  let newBalance = new SynthBalance(newBalanceID);
  newBalance.address = account;
  newBalance.account = account.toHex();
  newBalance.timestamp = timestamp;
  newBalance.synth = synthAddress.toHex();
  newBalance.amount = totalBalance;
  newBalance.save();
}

export function handleTransferSynth(event: SynthTransferEvent): void {
  if (event.params.from.toHex() != ZERO_ADDRESS.toHex() && event.params.from.toHex() != FEE_ADDRESS.toHex()) {
    trackSynthHolder(event.address, event.params.from, event.block.timestamp, toDecimal(event.params.value).neg());
  }
  if (event.params.to.toHex() != ZERO_ADDRESS.toHex() && event.params.to.toHex() != FEE_ADDRESS.toHex()) {
    trackSynthHolder(event.address, event.params.to, event.block.timestamp, toDecimal(event.params.value));
  }
}
