# Contributing

Thanks for taking a look. This project touches databases, so a few rules matter more than usual.

## Development

```bash
npm install
npm test
```

- Node.js ≥ 20, JDK 17+.
- The regression suite is offline: it uses SQLite and H2 and downloads those drivers once into `$JMG_HOME/drivers`.
- Add a regression assertion for every behavior change in `test/regress.js`.

## Pull requests

- Keep changes focused; write the **why** in the PR description.
- Any change to the write guard, audit or permission model must come with tests covering the bypass/rejection path.
- Do not add hard-coded hosts, credentials or company-specific logic.

## Security

If you believe you have found a bypass of the write guard, please **do not open a public issue first**. Open a private security advisory on GitHub (or contact the maintainer), with the SQL statement and the connection permissions used. We will acknowledge and fix as soon as possible.

Known and accepted trade-offs are documented in [docs/security-model.md](docs/security-model.md).
