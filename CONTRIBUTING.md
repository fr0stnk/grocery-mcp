# Contributing

Thanks for helping improve Grocery MCP. This guide covers the development setup and what a change needs before it is merged.

## Setup

You need Node.js 22.13 or newer and Docker with Compose.

```sh
git clone --recurse-submodules https://github.com/fr0stnk/grocery-mcp
cd grocery-mcp
(cd upstream/rami-levy-mcp && npm ci)      # also builds dist/
(cd upstream/shufersal-cart && npm ci)
cd server && npm ci
```

See [`server/README.md`](server/README.md) for how the server works, and the root [README](README.md#credentials) for store credentials. The tests need no credentials.

## Checks

Run these from `server/` before opening a pull request. CI runs the same checks.

```sh
npm run lint       # ESLint, recommended rules
npm test           # all tests, with stand-in store adapters and catalog
npm run coverage   # tests with coverage; fails below 95% lines, 80% branches, 85% functions
```

For the helper scripts, from the repository root:

```sh
python3 -m unittest discover -s scripts/tests -v
```

Add tests for new behavior. Tests use the fixtures in `server/test/fixtures/` and local stand-in servers, never the real stores. If a change depends on live store behavior, describe in the pull request how you verified it.

## Changes

- Keep each pull request focused on one change.
- Update the affected README files in the same pull request: the root README, `server/`, `scripts/` or `tunnel/`.
- Write commit messages that say what changed, why, and how it was verified.
- Write comments only for non-obvious constraints or decisions.
- Keep personal data out of code, examples and docs: account emails, store IDs, hostnames, tokens and real basket contents.
- The store integrations under `upstream/` are pinned submodules. Fix their bugs upstream, then update the pin in a separate pull request. Dependabot proposes new upstream revisions weekly.

## Versioning and releases

Releases follow [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`, tagged `vMAJOR.MINOR.PATCH`. The version lives in `server/package.json`. The server reports it to MCP clients, and CI refuses a release tag that does not match it.

| Bump | When | Examples |
|---|---|---|
| **MAJOR** | A change that breaks existing clients or deployments | Removing or renaming a tool, an argument or an output field; changing a field's meaning; renaming an environment variable or compose service; anything that needs manual steps on the server |
| **MINOR** | A backwards-compatible feature | A new tool or optional argument, a new output field, a new store, a new optional setting |
| **PATCH** | A backwards-compatible fix | A wrong price or size parse, an error message, a dependency or base image update, a documentation-only release |

While the version is `0.x`, the interfaces are still settling. A breaking change then bumps MINOR instead of MAJOR, as Semantic Versioning allows for initial development, and the release notes must call it out. Release `1.0.0` once the tools and settings are stable, and apply the table strictly from then on.

To release, from a clean `main`:

```sh
cd server && npm version minor --no-git-tag-version && cd ..   # or major / patch
git commit -am "Release v$(node -p "require('./server/package.json').version")"
git tag -a "v$(node -p "require('./server/package.json').version")" -m "Release notes summary"
git push origin main --follow-tags
```

The tag builds and publishes the images, creates the GitHub release, and deploys it to the server once the images are published.

## Images

Pull requests that touch image inputs run the tests and build every image for amd64 and arm64 without publishing. Merges to `main` publish them to GHCR. See [Images and CI](README.md#images-and-ci).
