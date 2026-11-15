# ADR-0004: Current Stable and Security-Patched Dependency Policy

- **Status:** Accepted
- **Date:** 15 November 2026

## Context

StackMate must not start implementation from stale tutorial versions or preserve outdated dependencies by habit. The current stable and secure release changes over time, so version choices must be verified at the time they are made.

## Decision

For every technology, runtime, framework, library, package, SDK, build tool, GitHub Action, and integration:

1. Verify the latest stable, generally available release at implementation time using official release notes, official documentation, the official package registry, or the vendor-maintained repository.
2. Prefer the latest stable major/minor line and its latest security-fixed patch that is compatible with the complete StackMate runtime and dependency graph.
3. Do not use prereleases, alpha/beta, preview, canary, nightly, release candidates, deprecated packages, or end-of-life releases in production without explicit product-owner approval.
4. Check peer dependencies, runtime support, framework compatibility, Cloudflare Workers constraints, database driver/ORM compatibility, and build/deploy tooling before selection.
5. Check official security advisories and known vulnerabilities. Do not select a release with a relevant unresolved critical/high advisory if a patched compatible release exists.
6. Pin exact dependency versions where appropriate and commit the lockfile for reproducibility. Keep the pinned versions current through reviewed updates; pinning is not permission to remain outdated.
7. Prefer full immutable commit-SHA pins for GitHub Actions, with comments naming the verified release.
8. If the newest stable major is incompatible or has a demonstrated blocker, choose the newest secure compatible stable release temporarily. Record evidence, reason, and upgrade condition in an ADR and report it.
9. Record the verification date, authoritative source links, exact versions, compatibility evidence, and exceptions in the implementation plan or ADR.
10. Re-check versions and advisories before the implementation milestone is declared complete.

"Latest" means the latest stable and security-patched version available at the time of work, subject to compatibility—not the latest prerelease or an unverified version string.

## Consequences

Dependency selection is an evidence-based engineering task. Agents must not infer current versions from memory, old lockfiles, stale articles, or tutorials. The completion report must list selected versions and authoritative sources.