import {
  SynthExchange as SynthExchangeEvent,
  ExchangeReclaim as ExchangeReclaimEvent,
  ExchangeRebate as ExchangeRebateEvent,
} from '../generated/subgraphs/exchanges/exchanges_Synthetix_0/Synthetix';

import { ExchangeRates } from '../generated/subgraphs/exchanges/ExchangeRates_13/ExchangeRates';

import { ExchangeFeeUpdated as ExchangeFeeUpdatedEvent } from '../generated/subgraphs/exchanges/exchanges_SystemSettings_0/SystemSettings';

import {
  Total,
  SynthExchange,
  Exchanger,
  ExchangeReclaim,
  ExchangeRebate,
  ExchangeFee,
  SynthByCurrencyKey,
} from '../generated/subgraphs/exchanges/schema';

import { Address, BigDecimal, BigInt, Bytes, dataSource, log } from '@graphprotocol/graph-ts';

import {
  getUSDAmountFromAssetAmount,
  getLatestRate,
  DAY_SECONDS,
  getTimeID,
  FIFTEEN_MINUTE_SECONDS,
  strToBytes,
  ZERO,
  YEAR_SECONDS,
} from './lib/helpers';
import { toDecimal, ZERO_ADDRESS } from './lib/helpers';
import { addDollar, addProxyAggregator } from './fragments/latest-rates';
import { Synthetix } from '../generated/subgraphs/latest-rates/ChainlinkMultisig/Synthetix';
import { AddressResolver } from '../generated/subgraphs/latest-rates/ChainlinkMultisig/AddressResolver';

const MAX_MAGNITUDE = 10;

function populateAggregatedTotalEntity(
  timestamp: BigInt,
  period: BigInt,
  bucketMagnitude: BigInt,
  synth: string | null,
): Total {
  let id = timestamp.toString() + '-' + bucketMagnitude.toString() + '-' + synth + '-' + period.toString();

  let entity = Total.load(id);

  if (entity != null) {
    return entity!;
  }

  entity = new Total(id);
  entity.timestamp = timestamp;
  entity.period = period;
  entity.bucketMagnitude = bucketMagnitude;
  entity.synth = synth;

  entity.trades = ZERO;
  entity.exchangers = ZERO;
  entity.newExchangers = ZERO;
  entity.exchangeUSDTally = new BigDecimal(ZERO);
  entity.totalFeesGeneratedInUSD = new BigDecimal(ZERO);

  return entity!;
}

function trackTotals(
  entity: Total,
  account: Address,
  actualTimestamp: BigInt,
  amountInUSD: BigDecimal,
  feesInUSD: BigDecimal,
): void {
  let exchangerId = account.toHex();

  if (entity.period != ZERO) {
    exchangerId = account.toHex() + '-' + entity.id;
  }

  let globalExchanger = Exchanger.load(account.toHex());
  let exchanger = Exchanger.load(exchangerId);

  if (globalExchanger == null) {
    entity.newExchangers = entity.newExchangers.plus(BigInt.fromI32(1));
  }

  if (exchanger == null) {
    entity.exchangers = entity.exchangers.plus(BigInt.fromI32(1));

    exchanger = new Exchanger(exchangerId);
    exchanger.firstSeen = actualTimestamp;
    exchanger.timestamp = entity.timestamp;
    exchanger.period = entity.period;
    exchanger.bucketMagnitude = entity.bucketMagnitude;
    exchanger.synth = entity.synth;

    exchanger.trades = ZERO;
    exchanger.exchangeUSDTally = new BigDecimal(ZERO);
    exchanger.totalFeesGeneratedInUSD = new BigDecimal(ZERO);
  }

  exchanger.lastSeen = actualTimestamp;

  entity.trades = entity.trades.plus(BigInt.fromI32(1));
  exchanger.trades = exchanger.trades.plus(BigInt.fromI32(1));

  if (amountInUSD && feesInUSD) {
    entity.exchangeUSDTally = entity.exchangeUSDTally.plus(amountInUSD);
    entity.totalFeesGeneratedInUSD = entity.totalFeesGeneratedInUSD.plus(feesInUSD);

    exchanger.exchangeUSDTally = exchanger.exchangeUSDTally.plus(amountInUSD);
    exchanger.totalFeesGeneratedInUSD = exchanger.totalFeesGeneratedInUSD.plus(feesInUSD);
  }

  entity.save();
  exchanger.save();
}

function addMissingSynthRate(currencyBytes: Bytes): BigDecimal {
  if (currencyBytes.toString() == 'sUSD' || currencyBytes.toString() == 'nUSD') {
    addDollar('sUSD');
    addDollar('nUSD');
    return toDecimal(BigInt.fromI32(1));
  }

  let snx = Synthetix.bind(dataSource.address());
  let resolver = AddressResolver.bind(snx.resolver());
  let exchangeRatesContract = ExchangeRates.bind(resolver.getAddress(strToBytes('ExchangeRates')));

  let aggregatorResult = exchangeRatesContract.aggregators(currencyBytes);

  if (aggregatorResult.equals(ZERO_ADDRESS)) {
    throw new Error('aggregator does not exist in exchange rates for synth ' + currencyBytes.toString());
  }

  addProxyAggregator(currencyBytes.toString(), aggregatorResult);

  return toDecimal(exchangeRatesContract.rateForCurrency(currencyBytes));
}

export function handleSynthExchange(event: SynthExchangeEvent): void {
  let txHash = event.transaction.hash.toHex();
  let fromCurrencyKey = event.params.fromCurrencyKey.toString();
  let toCurrencyKey = event.params.toCurrencyKey.toString();
  let latestFromRate = getLatestRate(fromCurrencyKey, txHash);
  let latestToRate = getLatestRate(toCurrencyKey, txHash);

  // may need to add new aggregator (this can happen on optimism)
  if (latestFromRate == null) {
    latestFromRate = addMissingSynthRate(event.params.fromCurrencyKey);
  }

  if (latestToRate == null) {
    latestToRate = addMissingSynthRate(event.params.fromCurrencyKey);
  }

  let account = event.params.account;
  let fromAmountInUSD = getUSDAmountFromAssetAmount(event.params.fromAmount, latestFromRate);
  let toAmountInUSD = getUSDAmountFromAssetAmount(event.params.toAmount, latestToRate);

  let feesInUSD = fromAmountInUSD.minus(toAmountInUSD);

  if (feesInUSD.lt(toDecimal(ZERO))) {
    let DEFAULT_FEE = toDecimal(BigInt.fromI32(3), 3);
    // this is an edge case. we can get pretty close to accurate by use of best guess of 30 bp
    feesInUSD = fromAmountInUSD.times(DEFAULT_FEE);
  }

  let fromSynth = SynthByCurrencyKey.load(fromCurrencyKey);
  let toSynth = SynthByCurrencyKey.load(toCurrencyKey);

  let fromSynthAddress = fromSynth != null ? fromSynth.proxyAddress : ZERO_ADDRESS;
  let toSynthAddress = toSynth != null ? toSynth.proxyAddress : ZERO_ADDRESS;

  let eventEntity = new SynthExchange(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  eventEntity.account = account.toHex();
  eventEntity.fromSynth = fromSynthAddress.toHex();
  eventEntity.toSynth = toSynthAddress.toHex();
  eventEntity.fromAmount = toDecimal(event.params.fromAmount);
  eventEntity.fromAmountInUSD = fromAmountInUSD;
  eventEntity.toAmount = toDecimal(event.params.toAmount);
  eventEntity.toAmountInUSD = toAmountInUSD;
  eventEntity.toAddress = event.params.toAddress;
  eventEntity.feesInUSD = feesInUSD;
  eventEntity.timestamp = event.block.timestamp;
  eventEntity.gasPrice = event.transaction.gasPrice;
  eventEntity.save();

  let synthOpts: (string | null)[] = [null, fromSynthAddress.toHex(), toSynthAddress.toHex()];

  let periods: BigInt[] = [
    YEAR_SECONDS,
    YEAR_SECONDS.div(BigInt.fromI32(4)),
    YEAR_SECONDS.div(BigInt.fromI32(12)),
    DAY_SECONDS.times(BigInt.fromI32(7)),
    DAY_SECONDS,
    FIFTEEN_MINUTE_SECONDS,
    ZERO,
  ];

  for (let s = 0; s < synthOpts.length; s++) {
    let synth = synthOpts[s];

    for (let p = 0; p < periods.length; p++) {
      let period = periods[p];
      let startTimestamp = period == ZERO ? ZERO : getTimeID(event.block.timestamp, period);

      for (let m = 0; m < MAX_MAGNITUDE; m++) {
        let mag = new BigDecimal(BigInt.fromI32(<i32>Math.floor(Math.pow(10, m))));
        if (fromAmountInUSD.lt(mag)) {
          break;
        }

        trackTotals(
          populateAggregatedTotalEntity(startTimestamp, period, BigInt.fromI32(m), synth),
          account,
          event.block.timestamp,
          fromAmountInUSD,
          feesInUSD,
        );
      }
    }
  }
}

export function handleExchangeReclaim(event: ExchangeReclaimEvent): void {
  let txHash = event.transaction.hash.toHex();
  let entity = new ExchangeReclaim(txHash + '-' + event.logIndex.toString());
  entity.account = event.params.account.toHex();
  entity.amount = toDecimal(event.params.amount);
  entity.currencyKey = event.params.currencyKey;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  let latestRate = getLatestRate(event.params.currencyKey.toString(), txHash);

  if (latestRate == null) {
    log.error('handleExchangeReclaim has an issue in tx hash: {}', [txHash]);
    return;
  }
  entity.amountInUSD = getUSDAmountFromAssetAmount(event.params.amount, latestRate);
  entity.save();
}

export function handleExchangeRebate(event: ExchangeRebateEvent): void {
  let txHash = event.transaction.hash.toHex();
  let entity = new ExchangeRebate(txHash + '-' + event.logIndex.toString());
  entity.account = event.params.account.toHex();
  entity.amount = toDecimal(event.params.amount);
  entity.currencyKey = event.params.currencyKey;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  let latestRate = getLatestRate(event.params.currencyKey.toString(), txHash);

  if (latestRate == null) {
    log.error('handleExchangeReclaim has an issue in tx hash: {}', [txHash]);
    return;
  }
  entity.amountInUSD = getUSDAmountFromAssetAmount(event.params.amount, latestRate);
  entity.save();
}

export function handleFeeChange(event: ExchangeFeeUpdatedEvent): void {
  let currencyKey = event.params.synthKey.toString();

  let entity = new ExchangeFee(currencyKey);
  entity.fee = toDecimal(event.params.newExchangeFeeRate);
  entity.save();
}
