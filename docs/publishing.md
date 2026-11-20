# Publishing & releases

Two publish targets: **npm** (the package) and the **MCP Registry** (metadata that points at that package). Both are cut from a `v*` tag.

## One-time setup

1. Add the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions → New repository secret). A granular npm token with publish access to `jdbc-mcp-guard` is enough.
2. Keep the registry identity in sync — the registry rejects a publish when these differ:
   - `package.json` → `"mcpName": "io.github.lyb-java/jdbc-mcp-guard"`
   - `server.json` → `"name": "io.github.lyb-java/jdbc-mcp-guard"`
3. Nothing to configure for GHCR: the workflow pushes with the built-in `GITHUB_TOKEN` (`packages: write`).

## Cutting a release

```bash
npm version patch --no-git-tag-version   # 0.3.2 -> 0.3.3, also updates package-lock.json
# update server.json version + packages[0].version, and CHANGELOG.md
git commit -am "release: v0.3.3"
git tag v0.3.3
git push origin main --tags
```

The tag starts `.github/workflows/release.yml`:

| Job | What it does |
|---|---|
| `verify` | `npm ci`, `npm test`, `npm run test:cli`; fails if the tag and `package.json` version disagree |
| `github-release` | `npm pack` + `gh release create --generate-notes` with the tarball attached |
| `npm` | `npm publish --provenance --access public`; skipped with a warning when `NPM_TOKEN` is missing |
| `docker` | builds `Dockerfile` and pushes `ghcr.io/lyb-java/jdbc-mcp-guard:<version>` and `latest` |

Manual fallback without Actions:

```bash
npm ci && npm test && npm publish --access public
```

## Publishing to the MCP Registry

The registry stores metadata only — publish the npm package first, then:

```powershell
# install the publisher (Windows PowerShell)
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe

# from the repo root
./mcp-publisher validate
./mcp-publisher login github
./mcp-publisher publish
```

- `mcp-publisher validate` checks `server.json` offline; run it before every publish.
- The registry limits `description` to **100 characters**.
- The server name must stay under `io.github.lyb-java/` (GitHub-based ownership).

## Verifying a release

```bash
npm view jdbc-mcp-guard version
npx jdbc-mcp-guard connections                        # lists connections and exits
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=jdbc-mcp-guard"
npm run docker:smoke                                  # container handshake (see scripts/docker-smoke.js)
```

The image defaults to `JMG_HOME=/data`; mount `-v ~/.jdbc-mcp-guard:/data` for real use.
