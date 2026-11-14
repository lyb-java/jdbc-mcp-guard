# GitHub access from this network

`github.com:443` is blocked on some corporate/home networks, but these endpoints are reachable:

| Endpoint | Purpose |
|---|---|
| api.github.com | REST API (gh works) |
| codeload.github.com | tarball / zip download |
| ssh.github.com:443 | Git over SSH (clone/push) |

So the repository uses an SSH remote on port 443:

~~~text
ssh://git@ssh.github.com:443/lyb-java/jdbc-mcp-guard.git
~~~

## Per-machine deploy keys

Each machine needs its own key. Private keys **must never be committed** — not to this
repo, not to `~/.dsh`, not to any git repository. The same repository can hold several
deploy keys (one per machine); each is revocable independently.

Run once per machine:

~~~powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-git-ssh.ps1
~~~

The script:

1. generates `~/.ssh/jdbc_mcp_guard_deploy` (ed25519, no passphrase) if missing;
2. adds a `Host ssh.github.com` block to `~/.ssh/config`;
3. prints the public key and the exact `gh api` command to register it.

Register the printed public key as a **deploy key with write access**:

- Web: repository -> Settings -> Deploy keys -> Add deploy key -> paste -> check *Allow write access*;
- CLI: the `gh api -X POST .../keys` command printed by the script (needs a token with repo scope).

Then verify and clone:

~~~bash
ssh -T git@ssh.github.com
git clone ssh://git@ssh.github.com:443/lyb-java/jdbc-mcp-guard.git
~~~

## Alternative: copy the key from another machine

Copying `jdbc_mcp_guard_deploy` (and `.pub`) over a secure channel (KeePass attachment,
USB stick, password manager) also works — the key is already registered for this repo.
Do **not** put it in git or in a synced plaintext folder.

## HTTPS fallback

If your network reaches github.com:443 directly (e.g. via a working proxy), the normal
HTTPS remote works too:

~~~bash
git remote set-url origin https://github.com/lyb-java/jdbc-mcp-guard.git
~~~
