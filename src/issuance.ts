// The latest Synthetix and event invocations
import {
  Synthetix as SNX,
  Transfer as SNXTransferEvent,
} from '../generated/subgraphs/issuance/issuance_Synthetix_0/Synthetix';

import { Synthetix32 } from '../generated/subgraphs/issuance/issuance_Synthetix_0/Synthetix32';

import { Synthetix4 } from '../generated/subgraphs/issuance/issuance_Synthetix_0/Synthetix4';

import { AddressResolver } from '../generated/subgraphs/issuance/issuance_Synthetix_0/AddressResolver';

import { sUSD32, sUSD4, toDecimal, ZERO_ADDRESS, ZERO } from './lib/helpers';
import { isEscrow } from './lib/util';
import { getTimeID } from './lib/helpers';

// SynthetixState has not changed ABI since deployment
import { SynthetixState } from '../generated/subgraphs/issuance/issuance_Synthetix_0/SynthetixState';

import {
  Vested as VestedEvent,
  RewardEscrow,
} from '../generated/subgraphs/issuance/issuance_RewardEscrow_0/RewardEscrow';

import {
  Synth,
  Issued as IssuedEvent,
  Burned as BurnedEvent,
} from '../generated/subgraphs/issuance/issuance_SynthsUSD_0/Synth';
import { FeesClaimed as FeesClaimedEvent } from '../generated/subgraphs/issuance/issuance_FeePool_0/FeePool';
import { FeePoolv217 } from '../generated/subgraphs/issuance/issuance_FeePool_0/FeePoolv217';

import {
  Synthetix,
  Issued,
  Burned,
  Issuer,
  SNXHolder,
  DebtSnapshot,
  RewardEscrowHolder,
  FeesClaimed,
  TotalActiveStaker,
  TotalDailyActiveStaker,
  ActiveStaker,
  DailyIssued,
  DailyBurned,
} from '../generated/subgraphs/issuance/schema';

import { store, BigInt, Address, ethereum, Bytes, dataSource } from '@graphprotocol/graph-ts';

import { strToBytes } from './lib/helpers';

import { log } from '@graphprotocol/graph-ts';
import { DAY_SECONDS } from './lib/helpers';
import { contracts } from '../generated/contracts';

let v219UpgradeBlock = BigInt.fromI32(9518914); // Archernar v2.19.x Feb 20, 2020

// [reference only] Synthetix v2.10.x (bytes4 to bytes32) at txn
// https://etherscan.io/tx/0x612cf929f305af603e165f4cb7602e5fbeed3d2e2ac1162ac61087688a5990b6
let v2100UpgradeBlock = BigInt.fromI32(8622911);

// Synthetix v2.0.0 (rebrand from Havven and adding Multicurrency) at txn
// https://etherscan.io/tx/0x4b5864b1e4fdfe0ab9798de27aef460b124e9039a96d474ed62bd483e10c835a
let v200UpgradeBlock = BigInt.fromI32(6841188); // Dec 7, 2018

function getMetadata(): Synthetix {
  let synthetix = Synthetix.load('1');

  if (synthetix == null) {
    synthetix = new Synthetix('1');
    synthetix.issuers = BigInt.fromI32(0);
    synthetix.snxHolders = BigInt.fromI32(0);
    synthetix.save();
  }

  return synthetix as Synthetix;
}

function incrementMetadata(field: string): void {
  let metadata = getMetadata();
  if (field == 'issuers') {
    metadata.issuers = metadata.issuers.plus(BigInt.fromI32(1));
  } else if (field == 'snxHolders') {
    metadata.snxHolders = metadata.snxHolders.plus(BigInt.fromI32(1));
  }
  metadata.save();
}

function decrementMetadata(field: string): void {
  let metadata = getMetadata();
  if (field == 'issuers') {
    metadata.issuers = metadata.issuers.minus(BigInt.fromI32(1));
  } else if (field == 'snxHolders') {
    metadata.snxHolders = metadata.snxHolders.minus(BigInt.fromI32(1));
  }
  metadata.save();
}

function trackIssuer(account: Address): void {
  let existingIssuer = Issuer.load(account.toHex());
  if (existingIssuer == null) {
    incrementMetadata('issuers');
    let issuer = new Issuer(account.toHex());
    issuer.save();
  }
}

function trackSNXHolder(
  snxContract: Address,
  account: Address,
  block: ethereum.Block,
  txn: ethereum.Transaction,
): void {
  let holder = account.toHex();
  // ignore escrow accounts
  if (isEscrow(holder, dataSource.network())) {
    return;
  }
  let existingSNXHolder = SNXHolder.load(holder);
  let snxHolder = new SNXHolder(holder);
  snxHolder.block = block.number;
  snxHolder.timestamp = block.timestamp;

  // // Don't bother trying these extra fields before v2 upgrade (slows down The Graph processing to do all these as try_ calls)
  if (dataSource.network() != 'mainnet' || block.number > v219UpgradeBlock) {
    let synthetix = SNX.bind(snxContract);
    snxHolder.balanceOf = toDecimal(synthetix.balanceOf(account));
    snxHolder.collateral = toDecimal(synthetix.collateral(account));

    // Check transferable because it will be null when rates are stale
    let transferableTry = synthetix.try_transferableSynthetix(account);
    if (!transferableTry.reverted) {
      snxHolder.transferable = toDecimal(transferableTry.value);
    }
    let resolverTry = synthetix.try_resolver();
    if (resolverTry.reverted) {
      // This happened when an old SNX token was reconnected to the old proxy temporarily to recover 25k SNX
      // from the old grantsDAO:
      // https://etherscan.io/tx/0x1f862d93373e6d5dbf2438f478c05eac67b2949664bf1b3e6a5b6d5adf92fb3c
      // https://etherscan.io/tx/0x84b4e312188890d744f6912f1e5d3387e2bf314a335a4418980a938e36b3ef34
      // In this case, the old Synthetix did not have a resolver property, so let's ignore
      log.debug('Skipping SNX holder tracking: No resolver property from SNX holder from hash: {}, block: {}', [
        txn.hash.toHex(),
        block.number.toString(),
      ]);
      return;
    }
    let resolverAddress = resolverTry.value;
    let resolver = AddressResolver.bind(resolverAddress);
    let synthetixState = SynthetixState.bind(resolver.getAddress(strToBytes('SynthetixState', 32)));
    let issuanceData = synthetixState.issuanceData(account);
    snxHolder.initialDebtOwnership = issuanceData.value0;

    // Note: due to limitations with how The Graph deals with chain reorgs, we need to try_debtLedger
    /*
        From Jannis at The Graph:
        graph-node currently makes contract calls by block number (that used to be the only way
        to do it and we haven't switched to calling by block hash yet). If there is a reorg,
        this may lead to making calls against a different block than expected.
        If the subgraph doesn't fail on such a call, the resulting data should be reverted as
        soon as the reorg is detected (e.g. when processing the next block). It can temporarily
        cause inconsistent data until that happens.
        However, if such a call fails (e.g. you're expecting an array to have grown by one but
        in the fork of the chain it hasn't and the call doesn't use try_), then this can cause
        the subgraph to fail.
        Here's what happens during a reorg:
        - Block 0xa (block number 100) is being processed.
        - A handler makes a try_debtLedger call against block number 100 but hits block 0xb instead of 0xa.
        - The result gets written to the store marked with block 0xa (because that's what we're processing).
        - The reorg is detected: block number 100 is no longer 0xa, it's 0xb
        - The changes made for 0xa (including the inconsistent/incorrect try_debtLedger result) are reverted.
        - Block 0xb is processed. The handler now makes the try_debtLedger call against 100 -> 0xb and the correct data is being returned
    */

    let debtLedgerTry = synthetixState.try_debtLedger(issuanceData.value1);
    if (!debtLedgerTry.reverted) {
      snxHolder.debtEntryAtIndex = debtLedgerTry.value;
    }
  } else if (block.number > v200UpgradeBlock) {
    // Synthetix32 or Synthetix4
    let synthetix = Synthetix32.bind(snxContract);
    // Track all the staking information relevant to this SNX Holder
    snxHolder.balanceOf = toDecimal(synthetix.balanceOf(account));
    snxHolder.collateral = toDecimal(synthetix.collateral(account));
    // Note: Below we try_transferableSynthetix as it uses debtBalanceOf, which eventually calls ExchangeRates.abs
    // It's slower to use try but this protects against instances when Transfers were enabled
    // yet ExchangeRates were stale and throwing errors when calling effectiveValue.
    // E.g. https://etherscan.io/tx/0x5368339311aafeb9f92c5b5d84faa4864c2c3878681a402bbf0aabff60bafa08
    let transferableTry = synthetix.try_transferableSynthetix(account);
    if (!transferableTry.reverted) {
      snxHolder.transferable = toDecimal(transferableTry.value);
    }
    let stateTry = synthetix.try_synthetixState();
    if (!stateTry.reverted) {
      let synthetixStateContract = synthetix.synthetixState();
      let synthetixState = SynthetixState.bind(synthetixStateContract);
      let issuanceData = synthetixState.issuanceData(account);
      snxHolder.initialDebtOwnership = issuanceData.value0;
      let debtLedgerTry = synthetixState.try_debtLedger(issuanceData.value1);
      if (!debtLedgerTry.reverted) {
        snxHolder.debtEntryAtIndex = debtLedgerTry.value;
      }
    }
  } else {
    // When we were Havven, simply track their collateral (SNX balance and escrowed balance)
    let synthetix = Synthetix4.bind(snxContract); // not the correct ABI/contract for pre v2 but should suffice
    snxHolder.balanceOf = toDecimal(synthetix.balanceOf(account));
    let collateralTry = synthetix.try_collateral(account);
    if (!collateralTry.reverted) {
      snxHolder.collateral = toDecimal(collateralTry.value);
    }
  }

  if (
    (existingSNXHolder == null && snxHolder.balanceOf.gt(toDecimal(BigInt.fromI32(0)))) ||
    (existingSNXHolder != null &&
      existingSNXHolder.balanceOf == toDecimal(BigInt.fromI32(0)) &&
      snxHolder.balanceOf > toDecimal(BigInt.fromI32(0)))
  ) {
    incrementMetadata('snxHolders');
  } else if (
    existingSNXHolder != null &&
    existingSNXHolder.balanceOf > toDecimal(BigInt.fromI32(0)) &&
    snxHolder.balanceOf == toDecimal(BigInt.fromI32(0))
  ) {
    decrementMetadata('snxHolders');
  }

  snxHolder.save();
}

function trackDebtSnapshot(event: ethereum.Event): void {
  let snxContract = event.transaction.to as Address;
  let account = event.transaction.from;

  // ignore escrow accounts
  if (isEscrow(account.toHex(), dataSource.network())) {
    return;
  }

  let entity = new DebtSnapshot(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.block = event.block.number;
  entity.timestamp = event.block.timestamp;
  entity.account = account;

  if (dataSource.network() != 'mainnet' || event.block.number > v219UpgradeBlock) {
    let synthetix = SNX.bind(snxContract);
    entity.balanceOf = toDecimal(synthetix.balanceOf(account));
    entity.collateral = toDecimal(synthetix.collateral(account));
    entity.debtBalanceOf = toDecimal(synthetix.debtBalanceOf(account, sUSD32));
    let addressResolverAddress = Address.fromHexString(
      contracts.get('addressresolver-' + dataSource.network()),
    ) as Address;
    let resolver = AddressResolver.bind(addressResolverAddress);
    let synthetixState = SynthetixState.bind(resolver.getAddress(strToBytes('SynthetixState', 32)));
    let issuanceData = synthetixState.issuanceData(account);
    entity.initialDebtOwnership = toDecimal(issuanceData.value0);
    let debtLedgerTry = synthetixState.try_debtLedger(issuanceData.value1);
    if (!debtLedgerTry.reverted) {
      entity.debtEntryAtIndex = debtLedgerTry.value;
    }
  }
  // Use bytes32
  else if (event.block.number > v2100UpgradeBlock) {
    let synthetix = Synthetix32.bind(snxContract);
    entity.balanceOf = toDecimal(synthetix.balanceOf(account));
    entity.collateral = toDecimal(synthetix.collateral(account));
    entity.debtBalanceOf = toDecimal(synthetix.debtBalanceOf(account, sUSD32));

    let addressResolverAddress = Address.fromHexString(
      contracts.get('addressresolver-' + dataSource.network()),
    ) as Address;
    let resolver = AddressResolver.bind(addressResolverAddress);
    let synthetixState = SynthetixState.bind(resolver.getAddress(strToBytes('SynthetixState', 32)));
    let issuanceData = synthetixState.issuanceData(account);
    entity.initialDebtOwnership = toDecimal(issuanceData.value0);
    let debtLedgerTry = synthetixState.try_debtLedger(issuanceData.value1);
    if (!debtLedgerTry.reverted) {
      entity.debtEntryAtIndex = debtLedgerTry.value;
    }
    // Use bytes4
  } else {
    let synthetix = Synthetix4.bind(snxContract); // not the correct ABI/contract for pre v2 but should suffice
    let balanceOfTry = synthetix.try_balanceOf(account);
    if (!balanceOfTry.reverted) {
      entity.balanceOf = toDecimal(balanceOfTry.value);
    }
    let collateralTry = synthetix.try_collateral(account);
    if (!collateralTry.reverted) {
      entity.collateral = toDecimal(collateralTry.value);
    }
    let debtBalanceOfTry = synthetix.try_debtBalanceOf(account, sUSD4);
    if (!debtBalanceOfTry.reverted) {
      entity.debtBalanceOf = toDecimal(debtBalanceOfTry.value);
    }

    entity.initialDebtOwnership = toDecimal(ZERO);
  }

  entity.save();
}

export function handleTransferSNX(event: SNXTransferEvent): void {
  if (event.params.from.toHex() != ZERO_ADDRESS.toHex()) {
    trackSNXHolder(event.address, event.params.from, event.block, event.transaction);
  }
  if (event.params.to.toHex() != ZERO_ADDRESS.toHex()) {
    trackSNXHolder(event.address, event.params.to, event.block, event.transaction);
  }
}

/**
 * Handle reward vest events so that we know which addresses have rewards, and
 * to recalculate SNX Holders staking details.
 */
// Note: we use VestedEvent here even though is also handles VestingEntryCreated (they share the same signature)
export function handleRewardVestEvent(event: VestedEvent): void {
  let entity = new RewardEscrowHolder(event.params.beneficiary.toHex());
  let contract = RewardEscrow.bind(event.address);
  entity.balanceOf = toDecimal(contract.balanceOf(event.params.beneficiary));
  entity.vestedBalanceOf = toDecimal(contract.totalVestedAccountBalance(event.params.beneficiary));
  entity.save();
  // now track the SNX holder as this action can impact their collateral
  let synthetixAddress = contract.synthetix();
  trackSNXHolder(synthetixAddress, event.params.beneficiary, event.block, event.transaction);
}

export function handleIssuedSynths(event: IssuedEvent): void {
  // We need to figure out if this was generated from a call to Synthetix.issueSynths, issueMaxSynths or any earlier
  // versions.

  let functions = new Map<string, string>();

  functions.set('0xaf086c7e', 'issueMaxSynths()');
  functions.set('0x320223db', 'issueMaxSynthsOnBehalf(address)');
  functions.set('0x8a290014', 'issueSynths(uint256)');
  functions.set('0xe8e09b8b', 'issueSynthsOnBehalf(address,uint256');

  // Prior to Vega we had the currency key option in issuance
  functions.set('0xef7fae7c', 'issueMaxSynths(bytes32)'); // legacy
  functions.set('0x0ee54a1d', 'issueSynths(bytes32,uint256)'); // legacy

  // Prior to Sirius release, we had currency keys using bytes4
  functions.set('0x9ff8c63f', 'issueMaxSynths(bytes4)'); // legacy
  functions.set('0x49755b9e', 'issueSynths(bytes4,uint256)'); // legacy

  // Prior to v2
  functions.set('0xda5341a8', 'issueMaxNomins()'); // legacy
  functions.set('0x187cba25', 'issueNomins(uint256)'); // legacy

  // so take the first four bytes of input
  let input = event.transaction.input.subarray(0, 4) as Bytes;

  // and for any function calls that don't match our mapping, we ignore them
  if (!functions.has(input.toHexString())) {
    log.debug('Ignoring Issued event with input: {}, hash: {}, address: {}', [
      event.transaction.input.toHexString(),
      event.transaction.hash.toHex(),
      event.address.toHexString(),
    ]);
    return;
  }

  let entity = new Issued(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.account = event.transaction.from;

  // Note: this amount isn't in sUSD for sETH or sBTC issuance prior to Vega
  entity.value = toDecimal(event.params.value);

  let synth = Synth.bind(event.address);
  let currencyKeyTry = synth.try_currencyKey();
  if (!currencyKeyTry.reverted) {
    entity.source = currencyKeyTry.value.toString();
  } else {
    entity.source = 'sUSD';
  }

  // Don't bother getting data pre-Archernar to avoid slowing The Graph down. Can be changed later if needed.
  if ((dataSource.network() != 'mainnet' || event.block.number > v219UpgradeBlock) && entity.source == 'sUSD') {
    let timestamp = getTimeID(event.block.timestamp, DAY_SECONDS);
    let synthetix = SNX.bind(event.transaction.to as Address);

    let issuedSynths = synthetix.try_totalIssuedSynthsExcludeOtherCollateral(strToBytes('sUSD', 32));
    if (issuedSynths.reverted) {
      issuedSynths = synthetix.try_totalIssuedSynthsExcludeEtherCollateral(strToBytes('sUSD', 32));
      if (issuedSynths.reverted) {
        // for some reason this can happen (not sure how)
        log.debug('Reverted issued try_totalIssuedSynthsExcludeEtherCollateral for hash: {}', [
          event.transaction.hash.toHex(),
        ]);
        return;
      }
    }

    let dailyIssuedEntity = DailyIssued.load(timestamp.toString());
    if (dailyIssuedEntity == null) {
      dailyIssuedEntity = new DailyIssued(timestamp.toString());
      dailyIssuedEntity.value = toDecimal(event.params.value);
    } else {
      dailyIssuedEntity.value = dailyIssuedEntity.value.plus(toDecimal(event.params.value));
    }
    dailyIssuedEntity.totalDebt = toDecimal(issuedSynths.value);
    dailyIssuedEntity.save();
  }

  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  entity.save();

  if (dataSource.network() != 'mainnet' || event.block.number > v200UpgradeBlock) {
    trackActiveStakers(event, false);
  }

  // track this issuer for reference
  trackIssuer(event.transaction.from);

  // update SNX holder details
  trackSNXHolder(event.transaction.to as Address, event.transaction.from, event.block, event.transaction);

  // now update SNXHolder to increment the number of claims
  let snxHolder = SNXHolder.load(entity.account.toHexString());
  if (snxHolder != null) {
    if (snxHolder.mints == null) {
      snxHolder.mints = BigInt.fromI32(0);
    }
    snxHolder.mints = snxHolder.mints.plus(BigInt.fromI32(1));
    snxHolder.save();
  }

  // update Debt snapshot history
  trackDebtSnapshot(event);
}

export function handleBurnedSynths(event: BurnedEvent): void {
  // We need to figure out if this was generated from a call to Synthetix.burnSynths, burnSynthsToTarget or any earlier
  // versions.

  let functions = new Map<string, string>();
  functions.set('0x295da87d', 'burnSynths(uint256)');
  functions.set('0xc2bf3880', 'burnSynthsOnBehalf(address,uint256');
  functions.set('0x9741fb22', 'burnSynthsToTarget()');
  functions.set('0x2c955fa7', 'burnSynthsToTargetOnBehalf(address)');

  // Prior to Vega we had the currency key option in issuance
  functions.set('0xea168b62', 'burnSynths(bytes32,uint256)');

  // Prior to Sirius release, we had currency keys using bytes4
  functions.set('0xaf023335', 'burnSynths(bytes4,uint256)');

  // Prior to v2 (i.e. in Havven times)
  functions.set('0x3253ccdf', 'burnNomins(uint256');

  // so take the first four bytes of input
  let input = event.transaction.input.subarray(0, 4) as Bytes;

  // and for any function calls that don't match our mapping, we ignore them
  if (!functions.has(input.toHexString())) {
    log.debug('Ignoring Burned event with input: {}, hash: {}, address: {}', [
      event.transaction.input.toHexString(),
      event.transaction.hash.toHex(),
      event.address.toHexString(),
    ]);
    return;
  }

  let entity = new Burned(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.account = event.transaction.from;

  // Note: this amount isn't in sUSD for sETH or sBTC issuance prior to Vega
  entity.value = toDecimal(event.params.value);

  let synth = Synth.bind(event.address);
  let currencyKeyTry = synth.try_currencyKey();
  if (!currencyKeyTry.reverted) {
    entity.source = currencyKeyTry.value.toString();
  } else {
    entity.source = 'sUSD';
  }

  // Don't bother getting data pre-Archernar to avoid slowing The Graph down. Can be changed later if needed.
  if ((dataSource.network() != 'mainnet' || event.block.number > v219UpgradeBlock) && entity.source == 'sUSD') {
    let timestamp = getTimeID(event.block.timestamp, DAY_SECONDS);
    let synthetix = SNX.bind(event.transaction.to as Address);
    let issuedSynths = synthetix.try_totalIssuedSynthsExcludeOtherCollateral(strToBytes('sUSD', 32));
    if (issuedSynths.reverted) {
      issuedSynths = synthetix.try_totalIssuedSynthsExcludeEtherCollateral(strToBytes('sUSD', 32));
      if (issuedSynths.reverted) {
        // for some reason this can happen (not sure how)
        log.debug('Reverted issued try_totalIssuedSynthsExcludeEtherCollateral for hash: {}', [
          event.transaction.hash.toHex(),
        ]);
        return;
      }
    }

    let dailyBurnedEntity = DailyBurned.load(timestamp.toString());
    if (dailyBurnedEntity == null) {
      dailyBurnedEntity = new DailyBurned(timestamp.toString());
      dailyBurnedEntity.value = toDecimal(event.params.value);
    } else {
      dailyBurnedEntity.value = dailyBurnedEntity.value.plus(toDecimal(event.params.value));
    }
    dailyBurnedEntity.totalDebt = toDecimal(issuedSynths.value);
    dailyBurnedEntity.save();
  }

  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  entity.save();

  if (dataSource.network() != 'mainnet' || event.block.number > v200UpgradeBlock) {
    trackActiveStakers(event, true);
  }

  // update SNX holder details
  trackSNXHolder(event.transaction.to as Address, event.transaction.from, event.block, event.transaction);
  // update Debt snapshot history
  trackDebtSnapshot(event);
}

export function handleFeesClaimed(event: FeesClaimedEvent): void {
  let entity = new FeesClaimed(event.transaction.hash.toHex() + '-' + event.logIndex.toString());

  entity.account = event.params.account;
  entity.rewards = toDecimal(event.params.snxRewards);
  if (dataSource.network() != 'mainnet' || event.block.number > v219UpgradeBlock) {
    // post Achernar, we had no XDRs, so use the value as sUSD
    entity.value = toDecimal(event.params.sUSDAmount);
  } else {
    // pre Achernar, we had XDRs, so we need to figure out their effective value,
    // and for that we need to get to synthetix, which in pre-Achernar was exposed
    // as a public synthetix property on FeePool
    let feePool = FeePoolv217.bind(event.address);

    if (event.block.number > v2100UpgradeBlock) {
      // use bytes32
      let synthetix = Synthetix32.bind(feePool.synthetix());
      // Note: the event param is called "sUSDAmount" because we are using the latest ABI to handle events
      // from both newer and older invocations. Since the event signature of FeesClaimed hasn't changed between versions,
      // we can reuse it, but accept that the variable naming uses the latest ABI
      let tryEffectiveValue = synthetix.try_effectiveValue(
        strToBytes('XDR', 32),
        event.params.sUSDAmount,
        strToBytes('sUSD', 32),
      );

      if (!tryEffectiveValue.reverted) {
        entity.value = toDecimal(tryEffectiveValue.value);
      } else {
        entity.value = toDecimal(BigInt.fromI32(0)); // Note: not sure why this might be happening. Need to investigat
      }
    } else {
      // use bytes4
      let synthetix = Synthetix4.bind(feePool.synthetix());
      entity.value = toDecimal(
        synthetix.effectiveValue(strToBytes('XDR', 4), event.params.sUSDAmount, strToBytes('sUSD', 4)),
      );
    }
  }

  entity.block = event.block.number;
  entity.timestamp = event.block.timestamp;

  entity.save();

  // now update SNXHolder to increment the number of claims
  let snxHolder = SNXHolder.load(entity.account.toHexString());
  if (snxHolder != null) {
    if (snxHolder.claims == null) {
      snxHolder.claims = BigInt.fromI32(0);
    }
    snxHolder.claims = snxHolder.claims.plus(BigInt.fromI32(1));
    snxHolder.save();
  }
}

function trackActiveStakers(event: ethereum.Event, isBurn: boolean): void {
  let account = event.transaction.from;
  let timestamp = event.block.timestamp;
  let snxContract = event.transaction.to as Address;
  let accountDebtBalance = BigInt.fromI32(0);

  if (dataSource.network() != 'mainnet' || event.block.number > v2100UpgradeBlock) {
    let synthetix = SNX.bind(snxContract);
    accountDebtBalance = synthetix.debtBalanceOf(account, sUSD32);
  } else if (event.block.number > v200UpgradeBlock) {
    let synthetix = Synthetix4.bind(snxContract);
    let accountDebt = synthetix.try_debtBalanceOf(account, sUSD4);
    if (!accountDebt.reverted) {
      accountDebtBalance = accountDebt.value;
    } else {
      log.debug('reverted debt balance of in track active stakers for account: {}, timestamp: {}, hash: {}', [
        account.toHex(),
        timestamp.toString(),
        event.transaction.hash.toHex(),
      ]);
      return;
    }
  }

  let dayTimestamp = getTimeID(timestamp, DAY_SECONDS);

  let totalActiveStaker = TotalActiveStaker.load('1');
  let activeStaker = ActiveStaker.load(account.toHex());

  if (totalActiveStaker == null) {
    totalActiveStaker = loadTotalActiveStaker();
  }

  // You are burning and have been counted before as active and have no debt balance
  // we reduce the count from the total and remove the active staker entity
  if (isBurn && activeStaker != null && accountDebtBalance == BigInt.fromI32(0)) {
    totalActiveStaker.count = totalActiveStaker.count.minus(BigInt.fromI32(1));
    totalActiveStaker.save();
    store.remove('ActiveStaker', account.toHex());
    ``;
    // else if you are minting and have not been accounted for as being active, add one
    // and create a new active staker entity
  } else if (!isBurn && activeStaker == null) {
    activeStaker = new ActiveStaker(account.toHex());
    activeStaker.save();
    totalActiveStaker.count = totalActiveStaker.count.plus(BigInt.fromI32(1));
    totalActiveStaker.save();
  }

  // Once a day we stor the total number of active stakers in an entity that is easy to query for charts
  let totalDailyActiveStaker = TotalDailyActiveStaker.load(dayTimestamp.toString());
  if (totalDailyActiveStaker == null) {
    updateTotalDailyActiveStaker(dayTimestamp, totalActiveStaker.count);
  }
}

function loadTotalActiveStaker(): TotalActiveStaker {
  let newActiveStaker = new TotalActiveStaker('1');
  newActiveStaker.count = BigInt.fromI32(0);
  return newActiveStaker;
}

function updateTotalDailyActiveStaker(timestamp: BigInt, count: BigInt): void {
  let newTotalDailyActiveStaker = new TotalDailyActiveStaker(timestamp.toString());
  newTotalDailyActiveStaker.timestamp = timestamp;
  newTotalDailyActiveStaker.count = count;
  newTotalDailyActiveStaker.save();
}
