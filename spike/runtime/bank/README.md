# The bank (alchemy's example)

_In the Trails runtime spike, this folder is a copy of the Manzanita Research
lab's `examples/bank` (at `cd145c2`), which is itself alchemy's example; see
"Changes" below._

The domain the `alchemy/Domain` docs are written around: customers, usernames,
accounts and transfers, with a saga, projections, a stream, two middlewares,
two outside systems (fraud scoring, payments) and two Apis. The lab's devtools
use it as their fixture, because it is a domain nobody there wrote.

It is a copy of `examples/cloudflare-domain/packages/domain` from
[alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) at commit
[`9e3c058`](https://github.com/alchemy-run/alchemy/tree/9e3c0584342d67b24a4215f931047aabd230327b/examples/cloudflare-domain/packages/domain),
the commit this workspace pins `alchemy` to. It is licensed under the Apache
License 2.0 ([`LICENSE`](LICENSE)); alchemy's [`NOTICE`](NOTICE) comes with it.

Changes from the original:

- `src/` is unchanged.
- `test/` (the stories) is left out: the spike hosts the model rather than
  testing it, and the trails repo's `bun test` would pick the file up.
- The lab's copy added a `package.json` and `tsconfig.json`; the spike drops
  both and builds this folder from `spike/runtime`'s own, which pins the same
  `alchemy` preview build (`9e3c058`) and `effect` 4.0.5.

The files keep alchemy's formatting, so formatting and lint skip this folder.
To take a newer version, copy the folder again from the commit `alchemy` is
pinned to.
