# Licences are activated on up to three devices, with a 30-day lease

This amends ADR 0006: a licence still unlocks every version, but it is no longer usable on an
unlimited number of devices. A key buys three seats, and a seat is a device the licence Worker has
seen activate it.

## Context

A signed key checked offline cannot tell one device from a thousand: the same key works wherever it
is pasted, so one buyer could resell it indefinitely and the only brake was the manual revocation
list. The trial already made a key necessary for editing, sync and AI; the key itself was the whole
of the control.

Devot stays local-first and account-free, so the seat check cannot be a request on every launch. It
also has to keep working for a laptop that is offline for weeks.

## Decision

- **A device is a random ID.** The app makes 16 random bytes on first use, keeps them in the
  keychain beside the key (account `device`) and sends them with the licence ID. Nothing is derived
  from the hardware, and the Worker stores no address, no machine name and no serial.
- **Activation takes a seat.** `POST /activate {key, device, label}` verifies the key, refuses a
  revoked licence and inserts the seat unless the licence already holds `MAX_DEVICES` (3 by default,
  a Worker variable). A device that already holds a seat refreshes it instead of taking another.
  A complimentary key (signed by hand, with no row in D1) activates too: the signature is the root
  of trust, and only a row that says it was revoked refuses it. The answer is a signed lease,
  `devot1dev.<payload>.<signature>`, whose payload names the licence, the device, when it was
  issued and when it ends (30 days). Requests are counted per licence and device, so a refused
  copy cannot spend the buyer's allowance.
- **The lease is checked offline.** The app verifies it with the same public keys as the licence and
  requires the licence ID and its own device ID to match, so a lease copied from another device is
  worthless. Without a live lease and without a migration window, notes are read-only, sync does not
  connect and AI does not send (`E_LICENCE_ACTIVATION_REQUIRED`, `E_LICENCE_ACTIVATION_EXPIRED`).
- **Renewal is part of the daily schedule.** The same thread that fetches the revocation list asks
  for a new lease once the current one is within 7 days of its end, and Settings > Licence has a
  Retry Activation button. A failed renewal keeps the lease that is there.
- **Freeing a seat.** `POST /deactivate {key, device}` and the Worker's `/devices` page (paste the
  key, remove a device) free a seat, for a device the buyer no longer has. The device keeps working
  until its lease ends, at most 30 days, which is what makes deactivation meaningful without a
  connection.
- **Keys bought before this change get 30 days, offline.** A key whose `issuedAt` is before
  2026-11-01, when the Worker cannot be reached (a network failure or a 5xx), starts a migration
  window of 30 days; until it ends everything works, and the first successful activation replaces
  it with a lease. No key has to be reissued. A key sold after that date gets no window, and a
  refusal from the Worker (a full seat count, a revoked licence, a rate limit) never opens one.
  A window is opened only on a device's first attempt for that key, and the device remembers every
  licence it has tried (capped at 32): pasting the key again, removing and re-adding it, swapping in
  another key and back, or going offline after a refusal does not restart it.
- **An unreadable seat locks.** A managed device whose seat item cannot be read or parsed is
  read-only with `E_LICENCE_ACTIVATION_UNREADABLE`, never treated as a build without seats; the
  read is tried again at the next tick. A seat item that does not parse can be replaced by pasting
  the key again, removing the licence or choosing Retry Activation, so the device is not locked out
  for good.
- **The licence itself does not change.** Same format, same offline signature, same revocation list,
  same three-day trial; a licence still unlocks every version and never expires.

## Consequences

- One key can be live on three devices at a time. A reseller can still share a key, but only within
  those seats, and the buyer can free them.
- The Worker learns a random device ID and a label the buyer sees; it still learns no address.
- A device offline for more than 30 days becomes read-only until it reaches the Worker once. That is
  the price of a deactivation that means something.
- The repository is source-available: someone who patches the check out can bypass it, as with the
  trial. Seats stop ordinary resale, not a determined cracker.
- A lost keychain item means a new device ID and a new seat; the buyer frees the old seat from
  `/devices` if all three are in use.

## Rejected

- **A one-time activation that never expires.** It keeps the offline promise, but a freed seat never
  stops working, so the buyer cannot recover from losing a device.
- **Checking with the Worker on every launch.** The strongest control, and the end of local-first.
- **Keygen, Lemon Squeezy or Polar.** Keygen has the right model (signed offline licence files with
  machine activations) but cannot keep the keys already sold, and the other two validate only
  online. The Worker adopts Keygen's model instead.
