# Domain-Driven Hexagon Scaffold

This scaffold generates independent applications, demonstrated by the User and
Wallet examples and their messaging, and operates their single-host installations.
Scaffold delivery covers how each application's images are approved, published and
verified in an installation.

## Language

### User and Wallet

**User**:
A profile identified by a unique email address, with an address and a role.

**Wallet**:
A balance associated with a user's identity. Each user has at most one wallet;
the wallet can remain after the user profile is removed.

### Messaging

**Messaging role**:
A RabbitMQ responsibility an application takes on: consumer or publisher.
Readiness is judged separately for each role the application uses.
_Avoid_: Worker, transport

**Consumer**:
The messaging role that receives deliveries addressed to an application's own queue.
_Avoid_: Worker, transport, listener

**Publisher**:
The messaging role that sends an application's pending integration events to the broker.
_Avoid_: Worker, transport

**Failure queue**:
A durable queue where an application keeps deliveries it could not accept,
unchanged, for operator inspection and replay.
_Avoid_: Dead-letter queue, DLQ

### Operations

**Installation**:
One operated set of applications with their owned identities, data and
infrastructure.

**Prepared environment**:
A development or test environment that one checkout prepares and owns, with
generated credentials and its own owned identities; never an installation.
_Avoid_: placement, workspace environment, owned environment

**Owned identity**:
The durable name of a resource an application owns in one installation or prepared
environment, such as its database, volume or owner role; assigned once and never
renamed. Names fixed by the application itself, such as its runtime role, are not
owned identities.
_Avoid_: resource name

**Desired selection**:
The images and ingress an operator wants an installation to run; a request, not
evidence that anything changed.
_Avoid_: deployment, deployment configuration

**Applied state**:
The images, outcomes and retained resources an installation actually has.
_Avoid_: deployment, current configuration

**Topology deployment**:
One explicitly applied, reviewed plan that moves an installation from its applied
state toward a desired selection, step by step.
_Avoid_: deployment, rollout

**Candidate**:
An image selected to become an application's applied image; unverified until its
verification succeeds.
_Avoid_: new version, release

**Promotion**:
The per-application procedure that makes a candidate the applied image. Applying a
plan, updating and rolling back each request one; a rollback is a promotion of an
older, compatibility-reviewed candidate without migrations.
_Avoid_: update (for the general procedure), upgrade

**Transition**:
The durable record of one promotion attempt.
_Avoid_: promotion (for the record)

**Continuation**:
An explicit resumption of an incomplete promotion or topology deployment that
never repeats completed migrations.
_Avoid_: retry, resume

### Scaffold delivery

**Artifact**:
The published, immutable image of one application, identified by its registry
digest and covering every supported platform.
_Avoid_: Release, image (when the published unit is meant)

**Platform image**:
One architecture's build of an application's image, identified by its local image
ID before publication.
_Avoid_: Artifact (for a single architecture)

**Image contract**:
The behavior every platform image must exhibit regardless of its business logic:
it runs on its target platform, separates migration and runtime privileges, keeps
its listener private and stops within its shutdown grace.
_Avoid_: Executable contract, capability fixture

**Artifact approval**:
The decision that a platform image meets the image contract and technical readiness
in disposable infrastructure. An artifact is published only when all its platform
images are approved.
_Avoid_: Publication validation, image validation, publication readiness

**Distribution scenario**:
An application-owned test of its distribution's business and lifecycle behavior;
during publication preparation it runs against an approved platform image.
_Avoid_: Application-owned scenario, distribution verification, functional scenario

**Approval receipt**:
The record of a preparation in which every selected platform image received
artifact approval; a failed or interrupted preparation has none.
_Avoid_: Validation result

**Technical readiness**:
The state in which an application serves private HTTP, its declared gateway routing
reaches it and every applicable messaging role is ready.
_Avoid_: Functional readiness, health

**Readiness snapshot**:
An application's aggregate report of its lifecycle and the readiness of each
declared capability, with disabled capabilities reported as not applicable.
_Avoid_: Health response, health status

**Candidate verification**:
The check that a candidate selected by a promotion runs with ready HTTP and
applicable messaging; unavailable messaging leaves it serving with verification
pending instead of failing it.
_Avoid_: Artifact approval, candidate validation
