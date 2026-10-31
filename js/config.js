// Everything this page knows about Tacit, in one place.
// Addresses mirror the protocol's published DEPLOYMENTS.md; asset ids are the
// pool's canonical keys (they are what every envelope and pool event carries).

export const DEPLOY_BLOCK = 25998736;

export const TACIT_API = 'https://api.tacit.finance';

export const POOL = {
  address: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  deployBlock: DEPLOY_BLOCK,
};

// Contract addresses published by the protocol (docs/DEPLOYMENTS.md).
export const CONTRACTS = [
  { address: '0x000000000Ed1eabD231Be41d93b719056F7febFC', name: 'ConfidentialPool', note: 'shielded note tree + nullifier set' },
  { address: '0x000000005dA3E3B73726af3c774Deeb9472D4992', name: 'ConfidentialRouter', note: 'wrap / settle router' },
  { address: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB', name: 'CollateralEngine', note: 'cUSD CDP + cBTC escrow (governed)' },
  { address: '0x0000000042c2D57499Df64BAF81bfA2C6E100535', name: 'CanonicalAssetFactory', note: 'mints canonical ERC20s per asset id' },
  { address: '0x00000000E36C7EC997CC59DCda9E03673B448119', name: 'TacitPublicAmm', note: 'public ETH-side AMM' },
  { address: '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3', name: 'TacitRelayer', note: 'relay of proven settles' },
  { address: '0x00000000Df8263Ac5810C53B31AaE20ee53C247f', name: 'BtcCallExecutor', note: 'fires T_BTC_CALL messages' },
  { address: '0x00000000a26a6E291972666a9687741dBa11Af46', name: 'EthCallOutbox', note: 'Ethereum→Bitcoin message outbox' },
  { address: '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0', name: 'BitcoinLightRelay', note: 'validated Bitcoin header relay' },
  { address: '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2', name: 'SP1 verifier', note: 'immutable Groth16 leaf' },
  { address: '0x000031C47Cb61faB1CE2790a69625FABB71EDE24', name: 'FarmManager', note: 'TAC launch farms' },
  { address: '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf', name: 'WrappedTac (wTAC)', note: '1:1 TAC wrapper, farm reward' },
  { address: '0x6919cbeF0e70AFFA02Ae02c86c532A137154f250', name: 'TacBuyback', note: 'relay surplus → TAC buyback' },
  { address: '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8', name: 'TacAirdrop', note: 'merkle distributor' },
  { address: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', name: 'TacitEvmPool', note: 'separate private-ETH pool (EVM chains)' },
  { address: '0x6e797ba2d3103aF167918e71a7E01DE40D45f74b', name: 'XNS', note: 'name registry (Alice@namespace)' },
];

// The canonical assets the pool itself keys everything by.
// `units` = the pool's in-system scale (amount / unitScale, SPEC §4.2).
export const ASSETS = [
  {
    id: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
    symbol: 'TAC',
    name: 'Tacit Coin',
    token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
    decimals: 18,
    units: 1e10,
    origin: 'Bitcoin T_CETCH, fixed supply 21,000,000',
  },
  {
    id: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34',
    symbol: 'tETH',
    name: 'Ether (one note, read on either chain)',
    token: null,
    decimals: 18,
    units: 1e10,
    origin: 'wrapped on Ethereum as cETH, spent on Bitcoin as tETH',
  },
  {
    id: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8',
    symbol: 'cBTC',
    name: 'Confidential BTC',
    token: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696',
    decimals: 18,
    units: 1e10,
    origin: 'minted against self-custody Bitcoin locks',
  },
  {
    id: '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d',
    symbol: 'cUSD',
    name: 'Confidential USD',
    token: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564',
    decimals: 18,
    units: 1e10,
    origin: 'CDP debt minted against cBTC collateral',
  },
  {
    id: '0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832',
    symbol: 'wTAC',
    name: 'Wrapped TAC',
    token: '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf',
    decimals: 18,
    units: 1e10,
    origin: '1:1 ERC20 wrapper, used as farm reward escrow',
  },
];

// Every EVM chain that runs a Tacit pool, and how to reach it.
export const CHAINS = {
  ethereum: {
    key: 'ethereum',
    id: 1,
    label: 'Ethereum',
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io',
    pool: POOL.address,
    deployBlock: DEPLOY_BLOCK,
  },
  base: {
    key: 'base',
    id: 8453,
    label: 'Base',
    rpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9',
    deployBlock: null,
  },
};

// Bitcoin-side plumbing. The page prefers a public Bitcoin Core node (one
// getblock call returns a whole block with witnesses, which is what the
// envelope decoder needs) and falls back to blockstream's Esplora API.
export const BITCOIN = {
  rpc: ['https://bitcoin-rpc.publicnode.com'],
  esplora: ['https://blockstream.info/api', 'https://mempool.space/api'],
  explorer: 'https://mempool.space',
  confirmations: 24,
};

export const XNS = {
  address: '0x6e797ba2d3103aF167918e71a7E01DE40D45f74b',
  chain: 'ethereum',
  // keccak selectors, computed offline and pinned here so the page needs no crypto lib
  sel: { getName: '0x5fd4b08a', getAddress: '0xbf40fac1' },
  site: 'https://xns.name',
};

// Pool getters worth reading straight off the chain (selectors pinned).
export const POOL_SELECTORS = {
  attestedReflectionTip: '0x182f6171',
  attestedReflectionDigest: '0xb909cdaf',
  attestedBitcoinConsumedCount: '0x281d8cc9',
  attestedCrossOutCount: '0xa6f8c9d6',
  assets: '0x9fda5b66',
  canonicalTokenFor: '0x0f65304b',
  totalSupply: '0x18160ddd',
};

// Opcode table (SPEC §5 + the amendments the indexer follows).
export const OPCODES = {
  0x21: { name: 'CETCH', family: 'etch', blurb: 'new asset, hidden supply' },
  0x22: { name: 'T_CXFER_BPP', family: 'transfer', blurb: 'confidential transfer (Bulletproofs+)' },
  0x23: { name: 'CXFER', family: 'transfer', blurb: 'confidential transfer' },
  0x24: { name: 'T_MINT', family: 'mint', blurb: 'issuer mint, hidden amount' },
  0x25: { name: 'T_BURN', family: 'burn', blurb: 'burn, amount public' },
  0x26: { name: 'T_AXFER', family: 'trade', blurb: 'atomic OTC settlement' },
  0x27: { name: 'T_PETCH', family: 'etch', blurb: 'fair-launch deployment' },
  0x28: { name: 'T_PMINT', family: 'mint', blurb: 'permissionless mint' },
  0x29: { name: 'T_DEPOSIT', family: 'pool', blurb: 'mixer deposit / POOL_INIT' },
  0x2a: { name: 'T_WITHDRAW', family: 'pool', blurb: 'mixer withdrawal' },
  0x2b: { name: 'T_DROP', family: 'drop', blurb: 'public-claim pool' },
  0x2c: { name: 'T_DCLAIM', family: 'drop', blurb: 'drop claim' },
  0x2d: { name: 'T_LP_ADD', family: 'amm', blurb: 'liquidity add' },
  0x2e: { name: 'T_LP_REMOVE', family: 'amm', blurb: 'liquidity remove' },
  0x2f: { name: 'T_SWAP_BATCH', family: 'amm', blurb: 'swap batch' },
  0x31: { name: 'T_PROTOCOL_FEE_CLAIM', family: 'amm', blurb: 'protocol fee claim' },
  0x32: { name: 'T_SWAP_VAR', family: 'amm', blurb: 'variable swap' },
  0x33: { name: 'T_SWAP_ROUTE', family: 'amm', blurb: 'routed swap' },
  0x34: { name: 'T_FARM_INIT', family: 'farm', blurb: 'farm init' },
  0x35: { name: 'T_LP_BOND', family: 'farm', blurb: 'bond LP shares' },
  0x36: { name: 'T_LP_UNBOND', family: 'farm', blurb: 'unbond LP shares' },
  0x37: { name: 'T_AXFER_VAR', family: 'trade', blurb: 'variable OTC settle' },
  0x38: { name: 'T_WRAPPER_ATTEST', family: 'attest', blurb: 'wrapper reserves attestation' },
  0x39: { name: 'T_SWAP_CHAINBOUND', family: 'amm', blurb: 'chain-bound swap' },
  0x3b: { name: 'T_LP_HARVEST', family: 'farm', blurb: 'harvest' },
  0x3c: { name: 'T_SWAP', family: 'amm', blurb: 'swap' },
  0x3d: { name: 'T_SWAP_VAR_2', family: 'amm', blurb: 'variable swap' },
  0x3e: { name: 'T_FARM_REFUND', family: 'farm', blurb: 'farm refund' },
  0x43: { name: 'T_SLOT_MINT', family: 'cbtc', blurb: 'cBTC slot mint' },
  0x44: { name: 'T_SLOT_BURN', family: 'cbtc', blurb: 'cBTC slot burn' },
  0x45: { name: 'T_SLOT_ROTATE', family: 'cbtc', blurb: 'cBTC slot rotate' },
  0x46: { name: 'T_SLOT_SPLIT', family: 'cbtc', blurb: 'cBTC slot split' },
  0x47: { name: 'T_SLOT_MERGE', family: 'cbtc', blurb: 'cBTC slot merge' },
  0x49: { name: 'T_CBTC_TAC_DEPOSIT', family: 'cbtc', blurb: 'cBTC↔TAC deposit' },
  0x4b: { name: 'T_CBTC_TAC_FORCE_CLOSE', family: 'cbtc', blurb: 'cBTC↔TAC force close' },
  0x4f: { name: 'T_CTAC_LIEN_SPLIT', family: 'cbtc', blurb: 'lien split' },
  0x5b: { name: 'T_PREAUTH_BID', family: 'trade', blurb: 'pre-authorized bid' },
  0x5c: { name: 'T_PREAUTH_BID_VAR', family: 'trade', blurb: 'pre-authorized bid (variable)' },
  0x60: { name: 'T_BRIDGE_DEPOSIT', family: 'bridge', blurb: 'Bitcoin → pool deposit' },
  0x61: { name: 'T_BRIDGE_BURN', family: 'bridge', blurb: 'Bitcoin → pool burn' },
  0x62: { name: 'T_BRIDGE_ROTATE', family: 'bridge', blurb: 'rotate a bridge leaf' },
  0x63: { name: 'T_BRIDGE_NOTE', family: 'bridge', blurb: 'encrypted recipient memo' },
  0x65: { name: 'T_CLAIM', family: 'claim', blurb: 'claim' },
  0x66: { name: 'T_LOCK', family: 'claim', blurb: 'stealth lock' },
  0x67: { name: 'T_SETTLE', family: 'claim', blurb: 'self-proved escrow settle' },
  0x68: { name: 'T_BTC_CALL', family: 'message', blurb: 'Bitcoin → Ethereum message' },
  0x69: { name: 'T_ETH_CALL', family: 'message', blurb: 'Ethereum → Bitcoin message' },
  0x6c: { name: 'T_SPEND', family: 'spend', blurb: 'Halo2 spend' },
  0x6d: { name: 'T_SPEND_BOUND', family: 'spend', blurb: 'Halo2 spend, deployment-bound' },
  0x6e: { name: 'T_AGGREGATE', family: 'spend', blurb: 'aggregate proof' },
};

// Ops that are really the pool's own bridge burn, disambiguated by payload length.
export const POOL_BRIDGE_BURN = { op: 0x2b, len: 161, name: 'T_POOL_BRIDGE_BURN' };
