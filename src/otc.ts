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
import { OTCTotal, Deal, Order, DailyOTC } from '../generated/subgraphs/otc/schema';
import { toDecimal } from './lib/util';

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
  if (0 == event.params.code) {
    order.currencyCode = 'CNY';
  } else {
    order.currencyCode = 'USD';
  }
  order.price = toDecimal(event.params.price);
  order.leftAmount = toDecimal(event.params.amount);
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
  order.leftAmount = toDecimal(event.params.amount);
  order.price = toDecimal(event.params.price);
  order.uTime = event.block.timestamp;
  order.save();
}

export function handleUpdateDeal(event: UpdateDealEvent): void {
  let deal = Deal.load(event.params.dealID.toString());
  if (deal == null) {
    deal = new Deal(event.params.dealID.toString());
    deal.cTime = event.block.timestamp;
  }
  deal.dealID = event.params.dealID;
  deal.uTime = event.block.timestamp;
  deal.block = event.block.number;
  deal.maker = event.params.maker;
  deal.taker = event.params.taker;

  let otcTotal = OTCTotal.load(otcTotalID);
  let dailyOTC = createDailyOTC(event.block);
  if (0 == event.params.dealState) {
    deal.dealState = 'Confirming';
    otcTotal.dealCountConfirming = otcTotal.dealCountConfirming.plus(BigInt.fromI32(1));

    // daily update
    dailyOTC.dealCountConfirming = dailyOTC.dealCountConfirming + BigInt.fromI32(1);
  } else if (1 == event.params.dealState) {
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
    let tradePeriod = event.block.timestamp - deal.cTime;
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

  let otc = OTC.bind(dataSource.address());
  let dealsTry = otc.try_deals(event.params.dealID);
  if (dealsTry.reverted) {
    log.error(`failed to get deal {}`, [event.params.dealID.toString()]);
    return;
  }
  deal.price = toDecimal(dealsTry.value.value1);
  deal.amount = toDecimal(dealsTry.value.value2);
  deal.collateral = toDecimal(dealsTry.value.value3);
  if (0 == dealsTry.value.value9) {
    deal.currencyCode = 'CNY';
  } else {
    deal.currencyCode = 'USD';
  }

  deal.save();
}
