# Explicit public image publication

The **Publish application images** workflow (`publish-images.yml`) publishes
one declared application or `all`. Pushes, pull requests and ordinary CI never
publish. Publication creates registry artifacts only; it does not deploy,
reconcile resources, migrate a live database, distribute operator secrets or
roll back an application.

## Package identity and initial setup

Images use `ghcr.io/<repository-owner>/<package-name>/<application>`.
The owner comes from the dispatched GitHub repository; the package name comes
from `scaffold.identity.json`, which [the rename command](adoption.md) updates.
A scoped package name drops its leading `@` and retains its scope path. Source
labels point to the dispatched repository and full commit SHA, including after
a hosted repository rename. No original maintainer namespace is hardcoded.

Before authorizing a first release, prepare every selected package, including
newly generated applications. GHCR initially creates packages as private;
linking a public repository does not make a container package public. The
workflow refuses missing or private packages before pushing any application.

1. A package administrator creates each package namespace with an explicitly
   authorized, empty bootstrap image tagged `visibility-setup`: a scratch
   image containing only an empty marker file and the
   `org.opencontainers.image.source=https://github.com/<owner>/<repository>`
   label. This is a separate registry write, not an application release or
   runtime-validation result.
2. In GitHub **Packages → package → Package settings**, change visibility to
   **Public**, confirm the source repository, and grant that repository write
   access under **Manage Actions access**. Repeat for each application package.
   Organization policies may require an administrator.
3. Verify visibility with the package API (organization owners use `orgs/OWNER`):

   ```sh
   gh api 'users/OWNER/packages/container/PACKAGE%2FAPPLICATION' --jq .visibility
   ```

The result must be `public`. The workflow repeats this check for the complete
selection and verifies anonymous registry reads. Only the publication job uses
`GITHUB_TOKEN` with `packages: write`; validation jobs have `contents: read`.
No application, database or deployment credentials are configured in the workflow.
See GitHub's [container registry guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
and [package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

## Select and trigger

Once the workflow exists on the default branch, select **Actions → Publish
application images → Run workflow**, choose the source ref, and enter an exact
application name or `all`. That ref resolves to one full commit SHA for all jobs.
The CLI equivalent is:

```sh
gh workflow run publish-images.yml --ref master -f application=user
gh workflow run publish-images.yml --ref master -f application=all
```

These commands authorize real registry publication. Inspect a plan without
building or publishing first (substitute the actual repository):

```sh
bun --no-env-file scripts/publication.ts plan all \
  --repository=OWNER/REPOSITORY --revision="$(git rev-parse HEAD)"
```

Selection uses declaration discovery, including newly generated applications.
Unknown names and empty discovery fail. There is no fixed selection list.

## Validation and artifact transfer

Each native Ubuntu runner builds its Linux architecture (`amd64` or `arm64`)
through the [local image contract](distribution.md#linux-oci-images): a frozen
target-Linux install and an independent runtime/migration dependency closure.
Preparation fixes the platform image ID before execution. Artifact approval is
implemented in `scripts/lib/artifact-approval.ts`, with explicit image, declaration,
environment and platform inputs, a monotonic clock and Docker/Kong adapters. The
internal `publication.ts approve` command runs only in a disposable environment
selecting exactly that application. It requires explicit `--image=<id>` and
`--platform` arguments and does not read `DDH_VALIDATED_IMAGE`,
`DDH_IMAGE_PLATFORM` or `DDH_PUBLICATION_READINESS` from the environment.

Every selected platform image first passes the image contract: target Linux
architecture, applicable owner migration up/status, refusal of another application
selector and runtime migration credentials, no migration interface without
persistence, a private listener and successful stop with Docker's 20-second grace.
Approval uses owned disposable infrastructure and temporary credentials. Runtime
containers have no checkout mounts.

Before distribution scenarios, every selected image passes technical readiness.
It checks private HTTP readiness and parses the readiness snapshot's application identity,
lifecycle, database capability and consumer/publisher states. Enabled messaging
requires at least one applicable role, with every applicable role ready and
connected; disabled messaging requires both roles to be not applicable and needs
no broker. HTTP 200, missing fields or unknown states alone cannot approve an image.

For exposed applications, the gate reads back Kong services, routes, associations
and active-check settings against the effective declaration. It marks the selected
target unhealthy with Kong's `PUT` API, observes `UNHEALTHY`, then requires
automatic recovery of the same target/address to `HEALTHY` through
`/health/ready/http`. Passive checks are disabled; configuration is not reloaded
and health is never manually reset between observations. Initial optimistic health
and a successful mutation response are insufficient. Health changes are restricted
to the inspected, owned disposable Kong. Disabled exposure installs no application
ingress; enabled exposure without routes invents no API request.

All technical readiness checks share one window of at most 60 seconds, measured
from before the platform image container starts. Each probe uses only the remaining budget.
Transient startup may recover within that window; persistent degradation or invalid
responses exhaust it without a receipt. The verdict contains ordered, distinct
unmet conditions or elapsed time and observed Kong transitions. The application
log retains that evidence, and bounded owned cleanup always runs.
The generic gate never invokes a business endpoint, authentication flow, GraphQL
query or message. REST, authenticated and state-changing route declarations are
valid. Configuration readback does not prove execution of route matching or
authentication.

After approval, preparation reads the resolved Nx graph and runs the selected
application project's optional `test-distribution` target. It supplies
`DDH_VALIDATED_IMAGE` (the exact immutable image ID) and `DDH_IMAGE_PLATFORM`.
The target contract requires execution of that image; tooling does not inspect
or enforce the target's implementation. A missing target is logged and approval
alone suffices. A failing target prevents the approval receipt. Discovery occurs
after image build and approval, preserving build/validation interruption phases.
User and Wallet own their business, messaging and image shutdown scenarios in
these targets. Ordinary startup and HTTP during broker outages keep their
separate contract.

Only approved platform images whose discovered distribution scenarios succeed
are archived. `validated.json` records source,
selection, IDs, target platform, Docker host architecture and native/emulated
execution. A failing selection produces no approval receipt. Publication waits
for **both complete architecture jobs**, loads their archives without rebuilding,
and checks IDs, architecture and source labels. Every package's visibility and
existing commit tags are checked before any push.

The local, non-publishing equivalent supports native or emulated execution:

```sh
bun --no-env-file scripts/publication.ts prepare user \
  --repository=OWNER/REPOSITORY --revision="$(git rev-parse HEAD)" \
  --platform=linux/arm64 --output=.context/publication/linux-arm64
```

The output directory must be new: failed attempts cannot reuse old approvals.
SIGINT/SIGTERM stop the active command, allow up to 90 seconds for owned test
infrastructure cleanup, remove the temporary build tag and return 130/143.
Interrupted preparation never writes an approval receipt. Forced termination or
an unavailable Docker daemon can still require the existing environment recovery
procedure in the [database workflow](database.md).
Only an explicit GitHub dispatch may invoke the publishing CLI. Keep archives
and receipts from the same run together; Actions archives expire after one day.
Do not upload environment manifests or operator files alongside them.

## Commit identity and independent release selection

For each application, publication writes `sha-<full-commit>-amd64` and
`sha-<full-commit>-arm64`, checks their public manifest config digests against
the executed image IDs, then creates `sha-<full-commit>` from those immutable
child digests. Anonymous reads verify the two-platform index. There is no
`latest` or default release tag. Existing commit tags with different artifacts
are refused; the same saved artifacts can resume a partial attempt. Rebuilt
images may differ even at the same source revision. Use **Re-run failed jobs**
to retry only the publication job while its original validation artifacts still
exist; do not rerun validation or replace those archives. Registry writes are
not transactional: failures can leave some
validated variants published. No rollback or deletion is attempted.

The job summary and `published-images` artifact contain `published.json`: source
SHA, application tags, immutable index and per-platform digests, and ready-to-select
`ghcr.io/.../application@sha256:...` references. Download through Actions or:

```sh
gh run download RUN_ID -n published-images -D .context/release
# Query a public tag without deploying it:
docker buildx imagetools inspect ghcr.io/OWNER/PACKAGE/user:sha-FULL_COMMIT
```

Use `images[].reference` as independent service `image:` selections in the
[operating reference design](scaffold-design.md#operating-procedures). User can
retain an earlier digest while Wallet selects a new one. The same owning digest
supplies any separately authorized migration process. Copying these references
does not start services or migrate databases. Those remain separately authorized
operator actions.

## Evidence boundaries

`check:full` executes local images on both architectures, including one/all
discovery with generated applications, absence of scenarios, User scenarios and
failures that withhold the approval receipt. Fast tests exercise the production
approval module with in-memory adapters and a manual clock: schema/capability
mismatches, deadlines, image contract failures, Kong proof, cancellation and
cleanup. Shared parser tests cover readiness snapshots and candidate verification
keeps inconsistent messaging snapshots pending. CI runs
the light image subset: image build, the two reproduced readiness defects and
ordinary startup. Workflow
checks cover the manual trigger, validation barrier, package permission and
absence of deployment commands. Registry-boundary tests exercise rejection and
write ordering with a test double; they do not prove GHCR publication or visibility.

Report implementation/local checks, remote CI, actual GHCR publication and actual
deployment separately. Until a maintainer authorizes and executes the workflow,
registry publication and real package-visibility verification remain **unexecuted**.
A green PR or local gate does not establish that packages exist.
