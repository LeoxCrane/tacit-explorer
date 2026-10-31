# tacit explorer

A block explorer for [Tacit](https://github.com/src-company/tacit), the confidential asset
protocol that lives in Taproot envelopes on Bitcoin and in shielded pools on Ethereum and Base.
Nine pages, read live from public endpoints, no wallet and no backend.

Live at **https://leoxcrane.github.io/tacit-explorer/**

## Pages

| Page | What it shows |
| --- | --- |
| `index.html` | TAC price, market cap and volume, envelopes and assets indexed, pool transactions, reflected height, Bitcoin tip, relay state; latest blocks and envelopes; links to the rest |
| `blocks.html` | the last six Bitcoin blocks; click one to fetch that whole block over JSON-RPC and decode its envelopes in the browser |
| `envelopes.html` | the recent envelope index with kind filters, decoded detail, public amounts where an operation publishes one, and an opcode legend |
| `pool.html` | leaves, nullifiers, deposits and cross-outs from the confidential pool, with the indexer's own lag stated |
| `bridge.html` | attested Bitcoin tip vs. the real block at that height, burns and mints, burns awaiting a bundle, burn deposits in flight |
| `assets.html` | TAC price with pool depth, canonical asset ids, live ERC20 supplies, the Bitcoin-native tETH/TAC AMM |
| `farms.html` | relay state, prover board, the open board of proven jobs, seven-day settle economics, farm emission |
| `privacy.html` | what an observer sees against what stays hidden, with live counters beside each claim |
| `search.html?q=…` | a Bitcoin txid, EVM transaction, EVM address, `tacit1` address or XNS name |

Themes: Light, Dim, Dark and Auto (system), remembered locally and applied before first paint.

## The envelope decoder

Tacit operations are taproot leaf scripts, revealed when the output is spent. `js/envelope.js`
reads that frame:

```
PUSH32 <signer> OP_CHECKSIG <empty> OP_IF "TACIT" 0x01 <payload> OP_ENDIF
```

The payload is an opcode byte plus that operation's fields. The decoder covers etches, mints,
burns, transfers and swaps, deposits and withdrawals, drops and claims, the bridge family and the
pool's 161-byte bridge burn, which shares opcode `0x2b` with `T_DROP` and is told apart by its
length. Operations whose layout it does not implement are labelled with their opcode and payload
size instead of being guessed at.

Amounts appear only where the protocol publishes them: burns, permissionless mints, fixed
denominations. Transfers carry Pedersen commitments, and `T_BRIDGE_NOTE` is an encrypted memo,
so neither is readable here or anywhere else without a key.

## Where the numbers come from

- `api.tacit.finance`: reflected state, pool index, relay, farms
- `blockstream.info`: Bitcoin tip, headers, transactions
- `bitcoin-rpc.publicnode.com`: whole blocks, for the in-browser decoder
- `ethereum-rpc.publicnode.com` and `base-rpc.publicnode.com`: pool getters, token supplies, XNS
- `tacitscan.io`: the envelope index and protocol counters
- `dexscreener.com`: the TAC price, from its Uniswap pools
- `xns.name`: the name registry at `0x6e79…f74b`

Two sources cannot be read from a browser directly: tacitscan sends no CORS headers, and the pool
index endpoint takes about ten seconds. `data/snapshot.json` holds a small copy of both, and the
`refresh data snapshot` workflow rebuilds it on a schedule and commits it when the data changes.
Every page works without it and says so; with it, the envelope table and pool list are instant.

## Run it locally

Any static server works. The repository ships one that serves files the way GitHub Pages does:

```bash
node tools/serve.mjs 8080     # http://127.0.0.1:8080/
```

To refresh the snapshot without waiting for the workflow:

```bash
node tools/snapshot.mjs
```

## Deploy

Push to GitHub, then **Settings → Pages → Deploy from a branch → `main` / `(root)`**. All paths are
relative, so the site works from a project subpath. `.nojekyll` keeps Jekyll out of the way.

To let the snapshot job commit fresh data, enable **Settings → Actions → General → Workflow
permissions → Read and write**.

## Notes

- Numbers are read live, and each card names the endpoint behind it.
- The envelope index is a snapshot rather than a live tail; its build time is shown on the card.
- The pool indexer can run behind the chain head. The page prints the gap instead of hiding it.
- Nothing here de-anonymises notes: amounts and owners are not visible to this page either.
- Not affiliated with Tacit. Built from the public specification and live mainnet data.

MIT licensed.
