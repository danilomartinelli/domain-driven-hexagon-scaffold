# Domain-Driven Hexagon Scaffold

This scaffold generates independent applications, demonstrated by the User and
Wallet examples, and operates their single-host installations.

## Language

### User and Wallet

**User**:
A profile identified by a unique email address, with an address and a role.

**Wallet**:
A balance associated with a user's identity. Each user has at most one wallet;
the wallet can remain after the user profile is removed.

### Operations

**Installation**:
One operated set of applications with their owned identities, data and
infrastructure.

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
