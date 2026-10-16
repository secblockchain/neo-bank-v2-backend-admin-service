# Admin domain writes (Mongo-only)

The admin service reads and sometimes **writes shared Mongo collections** owned by other US services (customer, US provider, subscriptions). Those writes are **operator convenience paths**: they update local documents and record an admin audit entry, but they may **not** call Rain / PayPal / Stripe / subscription domain APIs or emit the same webhooks as the owning service.

## Current Mongo-only (or primarily local) mutations

| Area | Admin routes (examples) | Shared collection(s) | Risk |
|------|-------------------------|----------------------|------|
| User account status / logout / verify | `/users/:id/account-status`, force-logout, verify-email | `rainusers` | Session invalidation is local; external IdP may diverge |
| Pilot allowlist add / deactivate | `/pilots`, `/pilots/:email/deactivate` | `pilotusers` | Gateway pilot cache TTL (~60s positive / ~15s negative); access may lag briefly after changes |
| KYC / KYB status | `/kyc/users/:id/status`, `/kyb/:id/status` | `rainkycs`, `rainkybs` | Provider application state may not match admin override |
| Subscription status | `/subscriptions/:id/status` | `subscriptions` | Billing provider / period logic may not run |
| Card lock / unlock / status / limit | `/cards/:id/*` | `cards` | Rain card controls may desync |
| Savings status / terminate / notes | `/savings-plans/:id/*` | `savingsplans` | Allocation jobs may still assume prior status |

## Operator guidance

1. Prefer **owning service / provider tools** when the change must sync externally (Rain card freeze, PayPal refund, etc.).
2. After an admin Mongo write, verify the customer app and provider dashboards if the change is compliance- or money-sensitive.
3. Impersonation tokens are **read-only** on customer and US-provider APIs (15m TTL). Use the **admin console** for mutations.

## Follow-up (engineering)

- Route sensitive writes through domain HTTP APIs or outbox events.
- Add allowlisted `$set` DTOs so loose schemas cannot accept arbitrary fields.
- Expand pending-action maker-checker for high-risk status changes.
