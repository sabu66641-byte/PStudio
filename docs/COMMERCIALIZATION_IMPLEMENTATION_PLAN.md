# PStudio Commercialization and Subscription Implementation Plan

Status: planning baseline (not a production billing implementation)
Date: 2026-11-25

## 1. Product principles

1. Free remains a complete game-development environment. Do not gate core language, 2D/3D rendering, ECS, physics, debugging, profiling, or Web builds behind a paid plan.
2. A paid entitlement must never silently reduce or corrupt an existing Free user's project, local assets, or quality settings.
3. Client-side plan labels are presentation only. Every paid capability and every billable server operation must be authorized by the server.
4. Resource targets are accounting/admission-control targets, not promises that a browser or GPU will allocate a fixed amount of memory.
5. Cloud data must remain exportable after downgrade. A downgrade must not trigger destructive cleanup.
6. Billing, storage, and execution quotas must be observable, bounded, and testable before public launch.

## 2. Repository baseline and implementation implications

The current application is a Flask application with a browser IDE. The normal .ps run path invokes a local C++17 compiler and executable through bounded subprocess handling, with a process concurrency semaphore. Project metadata is stored in the browser and model binaries are stored in IndexedDB. The repository does not currently expose an account/authentication system, a billing database, Stripe integration, cloud project storage, subscription webhooks, or team identity/permissions.

Consequences:
- Do not add subscription UI that pretends to sell access before server-side identity, persistence, and entitlements exist.
- Do not treat the existing in-process semaphore as a multi-instance quota system. It is process-local and cannot enforce a global paid/free execution allocation.
- Do not advertise cloud sync, 5GB/30GB storage, automatic cloud backups, or cross-device restore until durable server storage and recovery tests exist.
- Do not trust plan IDs, storage sizes, execution priority, or student status supplied by the browser.

## 3. Dependency-ordered implementation phases

### Phase 0 — Safety and product contract (first)

Deliverables:
- This implementation plan, a public-facing plan comparison draft, and a data-retention/deletion policy draft.
- Explicit definition of each quota: logical stored bytes, maximum single-file size, upload/download bandwidth, backup retention, restore limits, and execution fair-use windows.
- Threat model and cost model before enabling paid operations.

Exit criteria:
- Free functionality is explicitly protected by regression tests.
- Every paid feature has a server-owned entitlement and a measurable cost/limit.
- No real payment or personal data is collected in this phase.

### Phase 1 — Identity, persistence, and entitlement foundation

Recommended initial architecture:
- Use a durable relational database (PostgreSQL in production) with schema migrations.
- Add server-managed accounts and secure sessions before any user-specific cloud or billing feature.
- Model plans and entitlements separately from UI strings and price labels.
- Keep an append-only billing-event/audit trail for provider events and administrative changes.
- Store only payment-provider customer/subscription identifiers and status metadata; never store card numbers or security codes.

Core records (logical model):
- users: internal ID, normalized login identity, timestamps, account status.
- plans: stable plan key (free/pro/ultra), version, active flag.
- subscriptions: user ID, provider, provider customer/subscription IDs, status, current period boundaries, cancel-at-period-end, plan version.
- entitlements: user ID, feature key, limit/value, source subscription, effective start/end.
- billing_events: provider event ID (unique), event type, received/processed timestamps, processing result.
- usage_events/usage_counters: user, resource, quantity, time window, idempotency key.
- support_contributions: separate creator-support state and history; not an entitlement prerequisite for Pro/Ultra.
- student_verifications: minimal status, verification method, expiry, and provider/reference token; avoid retaining raw student-card images unless legally and operationally necessary.

Exit criteria:
- Authenticated user data is isolated across accounts.
- Entitlement checks are server-side and deny by default.
- Migrations, backups, restore, session expiry, CSRF protection, rate limits, and account deletion are tested.
- No payment flow is enabled yet.

### Phase 2 — Usage metering and resource governance

Deliverables:
- Server-side metering for cloud bytes, API requests, compile/run CPU time, wall time, output bytes, concurrency, and bandwidth.
- Client diagnostics for local CPU/GPU/cache telemetry, clearly labelled as estimates where browser APIs cannot expose physical usage.
- Atomic quota checks and bounded queues; do not rely on process-local counters in a multi-worker deployment.
- Fair-use limits and abuse detection that apply consistently across plans.

Important distinction:
- Browser CPU/GPU cache targets (128MiB / 512MiB / 1GiB+) are advisory local resource budgets, not server quotas and not guaranteed allocations.
- Paid plans must not receive artificially better rendering quality on the same device. Plan-based cache targets may be used only within device safety limits.

Exit criteria:
- Concurrent requests cannot bypass quotas.
- Memory pressure trims caches safely and does not dispose live resources.
- Metering is auditable and does not count retries or duplicate provider events twice.

### Phase 3 — Creator Support (separate from subscriptions)

Deliverables:
- Optional 300-yen monthly support product, independent of Free/Pro/Ultra.
- Provider-hosted checkout and customer portal.
- Support badge, contribution history, anonymous public display option, and progress reports.
- Webhook signature verification, event-ID deduplication, retry-safe processing, cancellation-at-period-end, failed-payment handling, and refunds.

Exit criteria:
- Support is never required to use Free or to subscribe to Pro/Ultra.
- A user can cancel without dark patterns.
- Public supporter display is opt-in and anonymous by default.
- The service does not claim support is a tax-deductible donation unless that status has been confirmed.

### Phase 4 — Pro/Ultra cloud storage and synchronization

Deliverables:
- Object storage for project archives and binary assets; database stores metadata and ownership.
- Pro 5GB and Ultra 30GB logical storage quotas, with separate per-file and transfer limits.
- Upload checksum validation, content-type validation, malware scanning where appropriate, signed short-lived download URLs, encryption in transit and at rest, and per-user authorization.
- Versioned uploads and recoverable deletes; no plan downgrade deletes data.
- Export-all and restore workflows before public release.

Exit criteria:
- Cross-account access tests fail closed.
- Interrupted uploads can resume or safely restart.
- Checksums detect corruption.
- Restore tests prove project and GLB assets remain usable.
- Downgraded accounts can view, edit, and export existing data; over-quota accounts cannot add new cloud bytes until below quota.

### Phase 5 — Pro/Ultra backups and version history

Deliverables:
- Scheduled snapshots and retention policies.
- Pro and Ultra retention periods defined publicly; Ultra receives longer retention only after backup costs are measured.
- Point-in-time restore with preview and explicit confirmation.
- Independent backup storage or provider-level versioning, plus periodic restore drills.

Exit criteria:
- Backups are not considered successful until restore is verified.
- A backup failure is visible and retried safely.
- Plan changes cannot erase a user's only recoverable copy.

### Phase 6 — Subscription checkout, plan changes, cancellation, and refunds

Deliverables:
- Provider-hosted checkout and customer portal (Stripe or another supported provider after fee, tax, and country availability review).
- Server-created checkout sessions; never accept client-supplied price amounts.
- Signed webhooks, unique event IDs, idempotent handlers, reconciliation jobs, and auditable state transitions.
- Cancel-at-period-end semantics; paid entitlements remain active through the paid-through timestamp.
- Proration for Pro-to-Ultra upgrades only after provider behavior and local tax treatment are tested.
- First-purchase seven-day refund policy implemented in accordance with provider rules and applicable law; clearly define whether the refund window is calendar-based and how it interacts with cancellation.

Exit criteria:
- Duplicate/out-of-order webhooks do not produce duplicate charges or entitlement changes.
- Provider and local subscription state can be reconciled.
- Failed payment, grace period, cancellation, refund, chargeback, and account closure are tested.
- Checkout, cancellation, and refund flows are usable on mobile.

### Phase 7 — Plan-specific production features

Implement only after metering and cost simulations:
- Pro/Ultra execution priority and extended execution capacity, using bounded server queues and isolation.
- Pro/Ultra logo-removal setting for eligible standalone exports.
- Official RPG/system/UI/event templates and Ultra shader packs.
- Ultra supporter credits (opt-in), roadmap voting, and beta access.
- Keep beta features isolated and clearly marked as unstable.

Exit criteria:
- No untrusted C++ executable runs inside the web application process or with access to secrets.
- Execution jobs run in isolated, resource-limited workers/containers with network and filesystem restrictions.
- Priority queues do not starve Free users; publish fair-use limits.

### Phase 8 — Student Pass

Deliverables:
- 50% discount entitlement for eligible Pro/Ultra subscriptions.
- Verification via school email or a privacy-minimizing independent verification flow.
- Store verification result and expiry, not unnecessary identity documents.
- Reverification and graduation/expiry rules communicated before checkout.

Exit criteria:
- Manual verification access is restricted and audited.
- Student data is deleted when no longer required.
- No school email is required when an approved alternative is available.

### Phase 9 — Team collaboration and asset library

Deliverables:
- Organization/workspace model, invitations, role-based access control, audit logs, conflict handling, and project sharing.
- Asset metadata, licensing, attribution, moderation/reporting, takedown workflow, and creator marketplace policy.
- Payment and creator payouts are a separate legal/tax/compliance project; do not treat marketplace sales as a simple extension of subscriptions.

Exit criteria:
- Workspace isolation and authorization tests pass.
- Concurrent editing and version conflicts are handled predictably.
- License and takedown workflows are operational before user uploads are publicly discoverable.

## 4. Security requirements (non-negotiable)

- Server-side authorization on every account, project, asset, billing, and usage endpoint.
- Secure password/session handling, CSRF protection, rate limiting, abuse monitoring, and secrets managed outside source control.
- Payment webhooks verified against provider signatures and deduplicated by immutable event ID.
- All state-changing billing operations are idempotent and auditable.
- Uploads are size-limited, validated, stored outside the application web root, and served only after authorization.
- C++ compilation/execution is isolated from the Flask web process and secrets.
- Backups are encrypted, access-controlled, and regularly restore-tested.
- No plan downgrade or billing failure may silently delete user projects.
- Collect the minimum personal data required and define deletion/retention schedules.

## 5. Cost and pricing validation

Before launch, calculate per-user and worst-case monthly cost for:
- Object storage, backup copies, requests, egress, and retention.
- Compile queue CPU time, worker memory, sandbox/container overhead, and peak concurrency.
- Payment processing fees, refunds, chargebacks, tax/accounting, email, identity verification, and support.
- Free-tier abuse and dormant-account retention.

The 5GB/30GB storage and execution entitlements are product targets, not commitments to unlimited transfer or compute. Publish file-size, bandwidth, backup-retention, and fair-use limits. Do not launch a plan whose plausible heavy-use cost exceeds its net revenue without a defined cap.

## 6. Legal, age, and launch gates

Before accepting real payments, obtain qualified review of Japanese consumer, subscription, privacy, tax, and payment requirements, including the Act on Specified Commercial Transactions and applicable consumer-protection rules. Review the exact checkout disclosures, recurring billing consent, cancellation path, refund policy, privacy notice, data-retention policy, and marketplace implications.

Because some PStudio users may be minors, confirm the payment provider's age and account requirements and establish an appropriate guardian-consent flow where required. Do not collect payment credentials or student documents directly in PStudio. Do not launch real billing until these requirements are confirmed by the provider and qualified advisers.

## 7. Release strategy

1. Local-only development and automated tests.
2. Internal staging with test payment credentials and synthetic users.
3. Private beta with low storage and execution caps, manual support, and verified restore drills.
4. Limited public rollout with monitoring and a kill switch for new paid signups.
5. Gradual quota increases only after measured costs and reliability justify them.

The first implementation PR should establish the data model, migration strategy, entitlement service contract, and tests without collecting payments or changing existing Free functionality. Each later phase should be a separate PR with explicit regression, security, and recovery criteria.
