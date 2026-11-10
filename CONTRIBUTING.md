# Contributing to CAIPE CLI

- Search [issues](https://github.com/caipe-io/caipe-cli/issues) and pull requests before starting related work.
- Discuss substantial changes in an issue before implementing them.
- Follow the [CAIPE Code of Conduct](https://github.com/caipe-io/governance/blob/main/CODE_OF_CONDUCT.md).
- Report suspected vulnerabilities privately under the [security policy](SECURITY.md).

## Development

Use Node.js 20.17 or newer and Bun with support for the committed `bun.lock`.
From the repository root:

```bash
bun install --frozen-lockfile
bun tsc --noEmit
bun run lint
bun run test
bun run build
```

CI runs type checking, lint, unit and end-to-end tests, a build, and a cold-start
check on Linux and macOS. See the [developer guide](README.md#developer-guide)
for native binary builds and local linking.

## Dependency management

- Keep `package.json` and `bun.lock` in sync; use Bun to update the lockfile.
- Review upstream changes, license compatibility, security advisories, and Node.js compatibility before adding or updating dependencies.
- Include the manifest and lockfile changes together in the same PR.
- Dependabot checks Bun packages and GitHub Actions weekly. Bot PRs require the same review and CI checks as other changes.
- Keep the four optional `caipe-*` platform packages aligned with the CLI release; the release workflow manages their versions.

## Pull requests

- Keep each PR focused and explain the problem, resulting behavior, and validation.
- Use Conventional Commits for commit messages and PR titles, such as `fix(auth): handle an expired session`.
- Disclose AI assistance in the PR description.
- Obtain approval from a project maintainer before merge and address review feedback.
- See [MAINTAINERS.md](MAINTAINERS.md) for the project roster and governance links.

## Developer Certificate of Origin

Every commit must include the contributor's own
[DCO](https://developercertificate.org/) sign-off:

```bash
git commit --signoff -m "docs(cli): clarify configuration"
```

Configure your Git name and email first. The resulting trailer has this form:

```text
Signed-off-by: Your Name <you@example.com>
```

Sign off only on contributions you have the right to submit.
