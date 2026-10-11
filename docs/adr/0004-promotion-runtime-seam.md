---
status: accepted
date: 2026-10-09
---

# Separate promotion decisions from installation runtime effects

Promotion and candidate verification will use a semantic runtime interface with
Docker and in-memory test adapters, while orchestration retains durable records
and recovery decisions. This replaces tests that interpret Docker arguments and
read orchestration records to manufacture runtime observations; injecting only a
command executor would preserve that coupling.

The first scope reuses the existing promotion module, preserving operator
behavior and the current polling window through an injectable clock. Unit tests
will exercise that module with independent simulated runtime state and real
temporary records, while CLI, signal and focused Docker tests retain evidence
that simulation cannot provide. Extracting all installation operations or
introducing a strict end-to-end verification deadline would broaden this work
beyond the chosen testability problem.

The [accepted design](../scaffold-design.md#promotion-runtime-seam) records the
scope and acceptance evidence. These decisions preserve
[ADR 0003](0003-application-capabilities-and-oci-delivery.md)'s installation and
recovery contracts; they do not establish implementation or executed validation.
