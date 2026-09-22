# Trails agent guidance

Current repository files and runtime output are authoritative. Do not rely on remembered versions, URLs, checksums, hostnames, or release state.

## Release work

Before staging, publishing, promoting, or rolling back Trails, read:

- `README.md`, especially **Release operations**;
- `MULTI-DEVICE.md`, especially **Release transport**;
- the shared release repository's `README.md`;
- `skill://trails-alpha-release` when that managed skill is available.

The release boundary is deliberate:

- Trails owns compilation, version selection, standalone binaries, its POSIX installer, checksums, and the validated staging directory produced by `bun run release:stage`.
- The shared `Manzanita-Research/releases` repository owns manifest validation, immutable object storage, upload ordering, public verification, channel promotion/rollback, the read-only Worker, and `releases.manzanita.dev`.

Do not put Cloudflare credentials, operator account data, or a hardcoded sibling-checkout path in Trails source. Pass the staging directory explicitly to the shared publisher.

The canonical human-facing installer is:

```text
https://releases.manzanita.dev/trails/install.sh
```

The alpha channel is:

```text
https://releases.manzanita.dev/trails/channels/alpha.json
```

The old here.now distribution and `release:alpha` workflow are retired. Never recreate them, add compatibility redirects, or reintroduce their URLs or configuration.

## Release invariants

- Versioned paths under `/trails/releases/<version>/` are immutable.
- If source or build inputs changed and fresh bytes differ, bump the version. Never publish changed bytes under an existing version.
- Validate the staging descriptor, files, sizes, hashes, architectures, installer syntax, and privacy boundary before publication.
- Audit release payloads for credentials, environment values, personal paths, transcripts or digests, private endpoints, source history, source maps, symlinks, and unexpected embedded files.
- Run the shared publisher with `--dry-run` before a real upload.
- A release becomes current only after every immutable public object verifies. Update the channel manifest and stable installer last.
- Promotion and rollback may only repoint mutable channel/bootstrap objects to an already published, publicly verified immutable release. Never mutate or delete versioned objects.
- Publication, deployment, DNS changes, live installation, and deletion are consequential external actions. Require direct authorization for the exact provider, product, version, channel, hostname, machines, and deletion target unless the current user message already grants it.

## Verification

For release changes, run the focused Trails tests, typecheck, production build, and `bun run release:stage`. In the shared release repository, run its tests, typecheck, Worker dry run, publisher dry run, and public verifier. Independently verify the live channel, installer, immutable manifest, sizes, hashes, `GET`, `HEAD`, ranges, and cache policy.

When exercising a live installation, preserve the machine's existing setup mode and verify service health, LaunchAgents, collection, backups, and summary processing. Never put private tailnet or machine details in public documentation or repository history.

## Effect

Before writing or changing Effect code, read the `effect` skill in `.agents/skills/effect/SKILL.md` (`.claude/skills/effect` links to the same directory). It is vendored unchanged from `kitlangton/skills` at commit `22c35cb`. To update it, copy `skills/effect` from that repository again instead of editing it here. Existing Trails conventions still apply.

## Repository discipline

Respect unrelated changes and other worktrees. Stage only task-owned files or hunks. Commit each coherent, verified change. Never commit generated release directories, binaries, downloaded verification artifacts, `.env` files, credentials, private operational output, or local hook logs.
