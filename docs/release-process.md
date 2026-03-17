# Release Process

This repository is set up for coordinated versioned releases across three surfaces:

- npm packages under `js/`
- Rust CLI release artifacts under `rust/`
- the relay Docker image published as `quadraa/relay`

## Versioning

Use one shared version across the JS workspace packages and Rust crates.

For the first public beta, the target version is:

```text
0.1.0-beta.1
```

## Tagging

Create a single Git tag for a coordinated release:

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

That tag drives:

- npm package publishing
- Rust release artifact builds and GitHub Release publishing
- relay Docker image publishing

## Release semantics

- Prerelease versions such as `0.1.0-beta.1` publish npm packages with the dist-tag `beta`
- Stable versions such as `0.1.0` publish npm packages with the dist-tag `latest`
- Prerelease relay Docker builds publish `quadraa/relay:<version>` and `quadraa/relay:beta`
- Stable relay Docker builds publish `quadraa/relay:<version>` and `quadraa/relay:latest`
- Rust GitHub Releases are marked as prereleases when the version contains `-`

## Required GitHub secrets

- `NPM_TOKEN`
- `DOCKERHUB_USERNAME` or `DOCKER_USERNAME`
- `DOCKERHUB_TOKEN` or `DOCKER_PASSWORD`

## Required local checks before tagging

```bash
pnpm --dir js release:check
cargo test --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

## Notes

- npm publishing is performed with `pnpm publish`, not `npm publish`, so workspace dependencies are rewritten to concrete published versions inside packed manifests.
- `rust/Cargo.lock` is expected to be committed so `--locked` release builds are reproducible.
