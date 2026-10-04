# Adopting the scaffold

The public project is **Domain-Driven Hexagon Scaffold**, with root package
`domain-driven-hexagon-scaffold` and MIT package metadata. [LICENSE](../LICENSE)
retains the original Sairyss copyright; [third-party notices](../THIRD_PARTY_NOTICES.md)
record upstream attribution. Renaming does not change either file or relicense
third-party content.

This guide describes the identity command shipped in
[issue #59](https://github.com/danilomartinelli/vibecoding-starter-js/issues/59).
The broader application-capability and OCI design in
[issue #58](https://github.com/danilomartinelli/vibecoding-starter-js/issues/58)
is a separate delivery plan. This command does not establish image publication,
deployment or completion of that design.

## Preview and apply

Complete the [developer setup](developer-checks.md#setup), then run from the
checkout root. Supply all six values; `--help` shows the interface.

```sh
bun run rename -- \
  --display-name="Acme Service" \
  --package-name=acme-service \
  --author="Acme Engineering" \
  --owner=acme \
  --repository=acme/service \
  --contact=https://github.com/acme
```

This defaults to **preview**: stdout is JSON containing each changed file and the
exact before/after fragments with their line numbers. It writes no files and
makes no network calls. Review the proposed changes, then repeat the same command
with **`--apply`** to write them:

```sh
bun run rename -- --apply \
  --display-name="Acme Service" \
  --package-name=acme-service \
  --author="Acme Engineering" \
  --owner=acme \
  --repository=acme/service \
  --contact=https://github.com/acme
```

Application recomputes the plan from the current files. Keep files and arguments
unchanged between preview and application to apply the same edits. Missing,
ambiguous or drifted identity fragments, symlinked surfaces and invalid arguments
fail before any planned edits are written. Review `git diff` afterward. Repeating
an applied identity reports an empty change list; subsequent renames read the
current values from [scaffold.identity.json](../scaffold.identity.json).

| Argument         | Meaning and accepted values                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `--display-name` | Public name, up to 100 characters: letters, numbers, spaces, dots, ampersands, apostrophes and hyphens |
| `--package-name` | Lowercase npm-style root name, optionally scoped; up to 214 characters                                 |
| `--author`       | Current maintainer name, using the same characters and length as the display name                      |
| `--owner`        | GitHub username or `org/team` for the default CODEOWNERS entry (without `@`)                           |
| `--repository`   | Current GitHub `owner/repository`, used to construct operational HTTPS links                           |
| `--contact`      | Maintainer HTTPS contact URL or `mailto:` address, up to 214 characters                                |

The command does not check hosted repository existence, contact reachability or
[CODEOWNERS permissions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax).
An organization uses a visible team, such as `--owner=acme/maintainers`, with
write access; an organization login alone is not a supported owner.
The selected repository and maintainer must be configured
separately by the adopter. Run the command before manually personalizing its
managed identity fragments; preserve their existing formatting.

## Managed surfaces and boundaries

The command uses this fixed list, with explicit fragments inside each file:

| File                                        | Managed identity                                             |
| ------------------------------------------- | ------------------------------------------------------------ |
| `scaffold.identity.json`                    | Current identity values for subsequent previews and renames  |
| `package.json`                              | Root name, author, repository, homepage and issue URL        |
| `bun.lock`                                  | Root workspace name only                                     |
| `README.md`, `README.pt-BR.md`              | Public title, its table-of-contents entry and CI badge links |
| `VISION.md`                                 | Current project title and opening description only           |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`     | Current maintainer and contact                               |
| `.github/CODEOWNERS`                        | Default owner                                                |
| `.github/ISSUE_TEMPLATE/config.yml`         | Current security-policy link                                 |
| `SECURITY.md`                               | Current private-advisory link                                |
| `AGENTS.md`, `docs/agents/issue-tracker.md` | Current issue repository                                     |

Everything else stays unchanged, including the `@starter` namespace, package
entry points, User/Wallet names, application behavior, infrastructure resource
names, license text, upstream links, third-party notices, the remainder of the vision/design records,
ADRs and historical issue links (including the implementation references above).
This is a bounded identity edit, not a repository-wide string replacement.

Neither mode renames branches or directories, edits `.git` or Git remotes,
renames the hosted repository, commits, pushes, publishes images or deploys.
The badge keeps the existing `master` branch reference. Repository transfers,
branch changes and infrastructure adoption are separate operations.

## Verification

`bun test ./scripts/tests/rename-project.test.ts` invokes the real public command
in disposable Git checkouts. It verifies preview without writes, application
matching the preview, current identity surfaces, unchanged Git configuration and
history, preserved out-of-scope content and a frozen-lockfile installation after
renaming. These tests also run in `bun run check:workspace` and the full gate.
They do not represent the deferred end-to-end journey for adopting a personalized
template.
