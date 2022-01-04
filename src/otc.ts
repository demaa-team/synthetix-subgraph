import {
  BigDecimal,
  BigInt,
  DataSourceContext,
  dataSource,
  log,
  Address,
  ethereum,
  Bytes,
} from '@graphprotocol/graph-ts';

import {
  RegisterProfile as RegisterProfileEvent,
  DestroyProfile as DestroyProfileEvent,
  UpdateDeal as UpdateDealEvent,
  OpenOrder as OpenOrderEvent,
  UpdateOrder as UpdateOrderEvent,
  CloseOrder as CloseOrderEvent,
  OTC,
} from '../generated/subgraphs/otc/OTC_0/OTC';

import {
  UpdateAdjudication as UpdateAdjudicationEvent,
  UpdateBlackList as UpdateBlackListEvent,
  UpdateVerifiedList as UpdateVerifiedListEvent,
  UpdateViolationCount as UpdateViolationCountEvent,
  OTCDao,
} from '../generated/subgraphs/otc/OTCDao_0/OTCDao';

import { OTCTotal, Deal, Order, DailyOTC, AdjudicationInfo, UserDaoInfo } from '../generated/subgraphs/otc/schema';
import { toDecimal, bytes32ToString } from './lib/util';

const otcTotalID = 'OTC_TOTAL';
const USDT = 'USDT';

function createOrder(orderID: BigInt): Order {
  let order = Order.load(orderID.toString());
  if (order == null) {
    order = new Order(orderID.toString());
  }
  return order as Order;
}

function createDailyOTC(block: ethereum.Block): DailyOTC {
  let dailyID = block.timestamp.toI32() / 86400;
  let dailyKey = dailyID.toString();
  let dailyOTC = DailyOTC.load(dailyKey);
  if (dailyOTC == null) {
    dailyOTC = new DailyOTC(dailyKey);
    dailyOTC.volume = BigInt.fromI32(0).toBigDecimal();

    dailyOTC.openProfile = BigInt.fromI32(0);
    dailyOTC.closedProfile = BigInt.fromI32(0);

    dailyOTC.openOrder = BigInt.fromI32(0);
    dailyOTC.closedOrder = BigInt.fromI32(0);

    dailyOTC.dealCountConfirming = BigInt.fromI32(0);
    dailyOTC.dealCountCanceled = BigInt.fromI32(0);
    dailyOTC.dealCountConfirmed = BigInt.fromI32(0);
  }
  dailyOTC.timestamp = block.number;
  dailyOTC.block = block.timestamp;

  return dailyOTC as DailyOTC;
}

export function handleRegisterProfile(event: RegisterProfileEvent): void {
  let otcTotal = OTCTotal.load(otcTotalID);
  if (otcTotal == null) {
    otcTotal = new OTCTotal(otcTotalID);
    otcTotal.userCount = BigInt.fromI32(1);
    otcTotal.orderCount = BigInt.fromI32(0);
    otcTotal.volume = toDecimal(BigInt.fromI32(0));
    otcTotal.longestTradePeroid = BigInt.fromI32(0);
    otcTotal.shortestTradePeroid = BigInt.fromI32(0);
    otcTotal.dealCountCanceled = BigInt.fromI32(0);
    otcTotal.dealCountConfirmed = BigInt.fromI32(0);
    otcTotal.dealCountConfirming = BigInt.fromI32(0);
  } else {
    otcTotal.userCount = otcTotal.userCount.plus(BigInt.fromI32(1));
  }
  otcTotal.block = event.block.number;
  otcTotal.timestamp = event.block.timestamp;
  otcTotal.save();

  let dailyOTC = createDailyOTC(event.block);
  dailyOTC.openProfile = dailyOTC.openProfile + BigInt.fromI32(1);
  dailyOTC.save();
}

export function handleDestroyProfile(event: DestroyProfileEvent): void {
  let otcTotal = OTCTotal.load(otcTotalID);
  otcTotal.block = event.block.number;
  otcTotal.timestamp = event.block.timestamp;
  otcTotal.userCount = otcTotal.userCount.minus(BigInt.fromI32(1));
  otcTotal.save();

  let dailyOTC = createDailyOTC(event.block);
  dailyOTC.closedProfile = dailyOTC.closedProfile + BigInt.fromI32(1);
  dailyOTC.save();
}

export function handleOpenOrder(event: OpenOrderEvent): void {
  let order = createOrder(event.params.orderID);
  order.block = event.block.number;
  order.cTime = event.block.timestamp;
  order.uTime = event.block.timestamp;
  order.orderID = event.params.orderID;
  order.maker = event.params.from;

  let otc = OTC.bind(dataSource.address());
  let orderTry = otc.try_orders(event.params.from);
  if (orderTry.reverted) {
    log.error('failed to get order {}', [event.params.from.toString()]);
    return;
  }

  order.coinCode = bytes32ToString(orderTry.value.value0);
  order.currencyCode = bytes32ToString(orderTry.value.value1);
  order.price = toDecimal(orderTry.value.value4);
  order.leftAmount = toDecimal(orderTry.value.value5);
  order.lockedAmount = toDecimal(orderTry.value.value6);
  order.closed = false;
  order.save();

  let otcTotal = OTCTotal.load(otcTotalID);
  otcTotal.orderCount = otcTotal.orderCount.plus(BigInt.fromI32(1));
  otcTotal.save();

  let dailyOTC = createDailyOTC(event.block);
  dailyOTC.openOrder = dailyOTC.openOrder + BigInt.fromI32(1);
  dailyOTC.save();
}

export function handleCloseOrder(event: CloseOrderEvent): void {
  let order = Order.load(event.params.orderID.toString());
  order.uTime = event.block.timestamp;
  order.price = new BigDecimal(BigInt.fromI32(0));
  order.leftAmount = new BigDecimal(BigInt.fromI32(0));
  order.closed = true;
  order.save();

  let otcTotal = OTCTotal.load(otcTotalID);
  otcTotal.orderCount = otcTotal.orderCount.minus(BigInt.fromI32(1));
  otcTotal.save();

  let dailyOTC = createDailyOTC(event.block);
  dailyOTC.closedOrder = dailyOTC.closedOrder + BigInt.fromI32(1);
  dailyOTC.save();
}

export function handleUpdateOrder(event: UpdateOrderEvent): void {
  let order = Order.load(event.params.orderID.toString());
  let otc = OTC.bind(dataSource.address());
  let orderTry = otc.try_orders(event.params.from);

  if (orderTry.reverted) {
    log.error(`failed to get order {}`, [event.params.from.toString()]);
    return;
  }

  order.price = toDecimal(orderTry.value.value4);
  order.leftAmount = toDecimal(orderTry.value.value5);
  order.lockedAmount = toDecimal(orderTry.value.value6);
  order.uTime = event.block.timestamp;
  order.save();
}

export function handleUpdateDeal(event: UpdateDealEvent): void {
  let deal = Deal.load(event.params.dealID.toString());
  if (deal == null) {
    deal = new Deal(event.params.dealID.toString());
    deal.cTime = event.block.timestamp;
  }
  deal.uTime = event.block.timestamp;
  deal.block = event.block.number;
  deal.dealID = event.params.dealID;

  let otc = OTC.bind(dataSource.address());
  let dealsTry = otc.try_deals(deal.dealID);
  if (dealsTry.reverted) {
    log.error(`failed to get deal {}`, [deal.dealID.toString()]);
    return;
  }

  deal.coinCode = bytes32ToString(dealsTry.value.value0);
  deal.currencyCode = bytes32ToString(dealsTry.value.value1);
  deal.orderID = dealsTry.value.value3;
  deal.price = toDecimal(dealsTry.value.value4);
  deal.amount = toDecimal(dealsTry.value.value5);
  deal.fee = toDecimal(dealsTry.value.value6);
  deal.maker = dealsTry.value.value9;
  deal.taker = dealsTry.value.value10;

  let dealCollateralsdealsTry = otc.try_dealCollaterals(deal.dealID);
  if (dealCollateralsdealsTry.reverted) {
    log.error(`failed to get dealCollaterals {}`, [deal.dealID.toString()]);
    return;
  }
  deal.collateralType = bytes32ToString(dealCollateralsdealsTry.value.value0);
  deal.lockedAmount = toDecimal(dealCollateralsdealsTry.value.value1);
  deal.collateral = toDecimal(dealCollateralsdealsTry.value.value2);

  let otcTotal = OTCTotal.load(otcTotalID);
  let dailyOTC = createDailyOTC(event.block);
  if (0 == dealsTry.value.value11) {
    deal.dealState = 'Confirming';
    otcTotal.dealCountConfirming = otcTotal.dealCountConfirming.plus(BigInt.fromI32(1));

    // daily update
    dailyOTC.dealCountConfirming = dailyOTC.dealCountConfirming + BigInt.fromI32(1);
  } else if (1 == dealsTry.value.value11) {
    deal.dealState = 'Cancelled';
    otcTotal.dealCountConfirming = otcTotal.dealCountConfirming.minus(BigInt.fromI32(1));

    otcTotal.dealCountCanceled = otcTotal.dealCountCanceled.plus(BigInt.fromI32(1));
    // daily update
    dailyOTC.dealCountCanceled = dailyOTC.dealCountCanceled + BigInt.fromI32(1);
  } else {
    deal.dealState = 'Confirmed';
    otcTotal.dealCountConfirming = otcTotal.dealCountConfirming.minus(BigInt.fromI32(1));
    otcTotal.dealCountConfirmed = otcTotal.dealCountConfirmed.plus(BigInt.fromI32(1));

    // daily update
    dailyOTC.dealCountConfirmed = dailyOTC.dealCountConfirmed + BigInt.fromI32(1);

    // should reffer to exchange rate?
    otcTotal.volume = otcTotal.volume + deal.amount;

    // longest and shortest trade periods
    let tradePeriod = event.block.timestamp - dealsTry.value.value7;
    if (tradePeriod > otcTotal.longestTradePeroid) {
      otcTotal.longestTradePeroid = tradePeriod;
      if (otcTotal.shortestTradePeroid == BigInt.fromI32(0)) {
        otcTotal.shortestTradePeroid = tradePeriod;
      }
    } else if (tradePeriod < otcTotal.shortestTradePeroid) {
      otcTotal.shortestTradePeroid = tradePeriod;
    }
  }
  otcTotal.save();
  dailyOTC.save();

  deal.save();
}

export function handleUpdateAdjudication(event: UpdateAdjudicationEvent): void {
  let adjudication = AdjudicationInfo.load(event.params.adjudicationID.toString());
  if (adjudication == null) {
    adjudication = new AdjudicationInfo(event.params.adjudicationID.toString());
    adjudication.cTime = event.block.timestamp;

    // update dispute count
    let userDaoInfo = createUserDaoInfoIfNotExist(adjudication.plaintiff.toString());
    userDaoInfo.uTime = event.block.timestamp;
    userDaoInfo.block = event.block.number;
    userDaoInfo.disputeCount += BigInt.fromI32(1);
    userDaoInfo.save();

    userDaoInfo = createUserDaoInfoIfNotExist(adjudication.defendant.toString());
    userDaoInfo.uTime = event.block.timestamp;
    userDaoInfo.block = event.block.number;
    userDaoInfo.disputeCount += BigInt.fromI32(1);
    userDaoInfo.save();
  }
  adjudication.uTime = event.block.timestamp;
  adjudication.dealID = event.params.adjudicationID;

  let otcDao = OTCDao.bind(dataSource.address());
  let adjudicationsTry = otcDao.try_adjudications(adjudication.dealID);
  if (adjudicationsTry.reverted) {
    log.error(`failed to get adjudications {}`, [adjudication.dealID.toString()]);
    return;
  }

  adjudication.plaintiff = adjudicationsTry.value.value2;
  adjudication.defendant = adjudicationsTry.value.value3;
  adjudication.adjudicator = adjudicationsTry.value.value4;
  adjudication.winner = adjudicationsTry.value.value5;
  adjudication.evidence = adjudicationsTry.value.value6;
  adjudication.explanation = adjudicationsTry.value.value7;
  adjudication.verdict = adjudicationsTry.value.value8;
  if (0 == adjudicationsTry.value.value9) {
    adjudication.progress = 'applied';
  } else if (1 == adjudicationsTry.value.value9) {
    adjudication.progress = 'responded';
  } else {
    adjudication.progress = 'adjudicated';
  }
  adjudication.save();
}

function createUserDaoInfoIfNotExist(who: string): UserDaoInfo {
  let userDaoInfo = UserDaoInfo.load(who);
  if (userDaoInfo == null) {
    userDaoInfo = new UserDaoInfo(who);
    userDaoInfo.who = Bytes.fromI32(0) as Bytes;
    userDaoInfo.isVerified = false;
    userDaoInfo.inBlackList = false;
    userDaoInfo.violationCount = BigInt.fromI32(0);
    userDaoInfo.usedNoCollateralCount = BigInt.fromI32(0);
    userDaoInfo.disputeCount = BigInt.fromI32(0);
    userDaoInfo.uTime = BigInt.fromI32(0);
    userDaoInfo.block = BigInt.fromI32(0);
  }

  return userDaoInfo as UserDaoInfo;
}

export function handleUpdateVerifiedList(event: UpdateVerifiedListEvent): void {
  let userDaoInfo = createUserDaoInfoIfNotExist(event.params.who.toString());
  userDaoInfo.uTime = event.block.timestamp;
  userDaoInfo.block = event.block.number;

  if (event.params.action == 0 || event.params.action == 1) {
    userDaoInfo.isVerified = true;

    let otcDao = OTCDao.bind(dataSource.address());
    let verifiedListTry = otcDao.try_verifiedList(event.params.who);
    if (verifiedListTry.reverted) {
      log.error(`failed to get verifiedList {}`, [event.params.who.toString()]);
      return;
    }
    userDaoInfo.usedNoCollateralCount = verifiedListTry.value.value1;
  } else {
    userDaoInfo.isVerified = false;
    userDaoInfo.usedNoCollateralCount = BigInt.fromI32(0);
  }

  userDaoInfo.save();
}

export function UpdateBlackList(event: UpdateBlackListEvent): void {
  let userDaoInfo = createUserDaoInfoIfNotExist(event.params.who.toString());
  userDaoInfo.uTime = event.block.timestamp;
  userDaoInfo.block = event.block.number;

  if (event.params.action == 0 || event.params.action == 1) {
    userDaoInfo.inBlackList = true;
  } else {
    userDaoInfo.inBlackList = false;
  }
  userDaoInfo.save();
}

export function handleUpdateViolationCount(event: UpdateViolationCountEvent): void {
  let userDaoInfo = createUserDaoInfoIfNotExist(event.params.who.toString());
  userDaoInfo.uTime = event.block.timestamp;
  userDaoInfo.block = event.block.number;

  let otcDao = OTCDao.bind(dataSource.address());
  let violationCountTry = otcDao.try_violationCount(event.params.who);
  if (violationCountTry.reverted) {
    log.error(`failed to get violationCountTry {}`, [event.params.who.toString()]);
    return;
  }
  userDaoInfo.violationCount = violationCountTry.value;
  userDaoInfo.save();
}
