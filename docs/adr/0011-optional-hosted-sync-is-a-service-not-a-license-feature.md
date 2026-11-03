# A hosted sync service, if it ever ships, is a separate service, not a license feature

Status: accepted.

Devot stays sold once. The license unlocks every feature, on every device, for every release, with no reduced rights for anyone who runs their own relay or none (ADR 0006). Running a relay yourself stays the supported way to sync (ADR 0004), and its limits are shown plainly in the app. A Devot-hosted sync service may come later for people who do not want to run a relay. If it does, it is a separate storage service, billed periodically by what it stores. It is not part of the license, and no feature is held back to sell it. This amends ADR 0004 and ADR 0006.

## What changes in ADR 0004 and ADR 0006

- **ADR 0004** says Devot runs no hosted sync service and that accounts and web sharing wait until one is decided. That stays true today: nothing in the app or the repository talks to a Devot-hosted sync endpoint. What changes is the door left open. A hosted relay for people who choose it is allowed, and it does not change how sync is built: it is the same relay, protocol, pairing and encryption, at another address, and the relay only ever sees ciphertext.
- **ADR 0006** says "a license names a plan (`pro`), not a list of features, so a paid feature added later reaches every license." Hosting is not a feature of that kind. It is a service with a running cost, which a license bought once cannot pay for. So the sentence holds for features, and a hosted service is outside it: buying a license never entitles anyone to hosting, and not buying hosting never removes a feature. Sync with a relay of one's own works the same for every license.
- The principle "no account is needed for anything" holds for the app. Hosting, if it ships, needs some way to bill and to tell one customer's storage from another's. What that identity is, and whether it is an account in the usual sense, is undecided (below).

## Decided

- The app is sold once. No license, trial or feature depends on how a person syncs.
- Hosting is a separate, optional, periodically billed storage service for anyone, not a tier of the license.
- A person who runs their own relay (on Cloudflare's free plan or a server of their own) loses nothing and sees the same features. The app reports that relay's storage honestly: what it holds, what it may hold as the relay itself says, and what is left (docs/sync-relay.md, Quota). It never assumes a host's limits.
- When a relay's storage nears its cap, the app says so once and says what to do: remove images or notes, or use a larger server. Hosting is not mentioned there, because there is nothing to offer yet.
- Nothing is built now: no billing, no accounts, no hosted endpoint, no interest form, and no other sync backend (CloudKit included).

## Not decided

- What it costs to run, per gigabyte stored and per request, on which host.
- The price, and whether it is billed monthly or yearly.
- The identity billing needs: how a customer is told from another, whether the relay secret and vault ID are enough, or whether an account is needed. It must not give the service a way to read notes: the vault key never leaves a customer's devices.
- How a hosted relay is limited and protected against abuse, how a customer's data is exported and deleted, and what happens when payment stops (read-only access to the stored vault, then a grace period before deletion is the likely shape).
- Whether to launch at all. Hosting launches only after demand is gauged, and that is not done inside the app. Until then the principle above is all that is fixed.

## Consequences

- Hosting never appears in the app, the Welcome screen or the first launch. Settings > Sync stays the one place where sync is set up, and its first question is only whether this is the first device or another one.
- A relay's storage is read from the relay itself (`usage`: stored bytes, image bytes and the relay's own `caps`), so the figures are right for any host, and a relay that does not say its caps is shown as such. A relay run with `RELAY_QUOTA=off` is shown as having no cap.
- The decision is revisited only when there is evidence of demand and a costed plan. It then gets its own ADR, which settles the points under "Not decided".
