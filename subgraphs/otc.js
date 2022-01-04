const { getContractDeployments, getCurrentNetwork } = require('./utils/network');

const manifest = [];

getContractDeployments('OTC', 0, Number.MAX_VALUE, 'mumbai').forEach((a, i) => {
  console.log(`startBlock ${a.startBlock}`);
  manifest.push({
    kind: 'ethereum/contract',
    name: `OTC_${i}`,
    network: getCurrentNetwork(),
    source: {
      address: a.address,
      startBlock: a.startBlock,
      abi: 'OTC',
    },
    mapping: {
      kind: 'ethereum/events',
      apiVersion: '0.0.4',
      language: 'wasm/assemblyscript',
      file: '../src/otc.ts',
      entities: ['OTCTotal', 'Order', 'Deal', 'DailyOTC'],
      abis: [
        {
          name: 'OTC',
          file: '../abis/OTC.json',
        },
      ],
      eventHandlers: [
        {
          event: 'RegisterProfile(indexed address,string)',
          handler: 'handleRegisterProfile',
        },
        {
          event: 'DestroyProfile(indexed address)',
          handler: 'handleDestroyProfile',
        },
        {
          event: 'OpenOrder(indexed address,uint256)',
          handler: 'handleOpenOrder',
        },
        {
          event: 'CloseOrder(indexed address,uint256)',
          handler: 'handleCloseOrder',
        },
        {
          event: 'UpdateOrder(indexed address,uint256)',
          handler: 'handleUpdateOrder',
        },
        {
          event: 'UpdateDeal(indexed address,indexed address,uint256,uint8)',
          handler: 'handleUpdateDeal',
        },
      ],
    },
  });
});

getContractDeployments('OTCDao', 0, Number.MAX_VALUE, 'mumbai').forEach((a, i) => {
  console.log(`startBlock ${a.startBlock}`);
  manifest.push({
    kind: 'ethereum/contract',
    name: `OTCDao_${i}`,
    network: getCurrentNetwork(),
    source: {
      address: a.address,
      startBlock: a.startBlock,
      abi: 'OTCDao',
    },
    mapping: {
      kind: 'ethereum/events',
      apiVersion: '0.0.4',
      language: 'wasm/assemblyscript',
      file: '../src/otc.ts',
      entities: ['AdjudicationInfo', 'UserDaoInfo'],
      abis: [
        {
          name: 'OTCDao',
          file: '../abis/OTCDao.json',
        },
      ],
      eventHandlers: [
        {
          event: 'UpdateAdjudication(indexed address,uint256)',
          handler: 'handleUpdateAdjudication',
        },
        {
          event: 'UpdateVerifiedList(indexed address,indexed address,uint8)',
          handler: 'handleUpdateVerifiedList',
        },
        {
          event: 'UpdateBlackList(indexed address,indexed address,uint8)',
          handler: 'handleUpdateUpdateBlackList',
        },
        {
          event: 'UpdateViolationCount(indexed address,indexed address)',
          handler: 'handleUpdateViolationCount',
        },
      ],
    },
  });
});

module.exports = {
  specVersion: '0.0.2',
  description: 'Synthetix OTC API',
  repository: 'https://github.com/demaa-team/synthetix-subgraph',
  schema: {
    file: './otc.graphql',
  },
  dataSources: manifest,
};
