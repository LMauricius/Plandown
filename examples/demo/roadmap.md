# [Task] Pantry 1.0
    Priority: 1
    effort: 4
    spent: 1

The first public release of Pantry, a recipe app that keeps working in the kitchen without a connection.

## [Task] Offline mode
    Due-date: 2026-12-01
    Priority: 1
    effort: 16
    spent: 3.5

Recipes, shopping lists and edits keep working without a network and sync when it returns.

Blocked by:
- [Task] Account system

Sync starts only after sign-in, so offline data always belongs to an account.

### Open questions
- Should photos be cached, or only the text?
- How long are deleted recipes kept?

### [Task] Design the sync protocol
    effort: 4
    spent: 2

Last-write-wins or per-field merges? This **needs** a short write-up.

### [Task] Local recipe cache

### [Task] Conflict resolution

## [Task] Account system
Sign-in with an email address or a single sign-on provider.

### [Task] Choose an auth provider
    effort: 6
    done: true

The hosted provider with passkeys and a free tier won.

### [Task] Password reset flow

## [Task] Onboarding screens
    Priority: 2
    effort: 5

Three screens that introduce offline mode and recipe import. They reuse the store listing's wording, and the listing needs screenshots of them, so the two are written side by side.

Blocked by:
- [Task] Store listing
