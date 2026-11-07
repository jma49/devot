# Rotating the vault key moves the devices to a new vault and retires the old one

Status: accepted (2026-11-05). Amends ADR 0002 (Relay), ADR 0008 (What the new device learns, Rules on both joins), ADR 0015 (Devices list, A lost device) and ADR 0016 (store names). The relay part, with clearing the relay of retired and abandoned vaults, and the iCloud part (#641) are built; the follow-ups below are separate issues.

A removed or lost device still holds the vault key. On a relay it can enroll again on purpose (ADR 0008); on iCloud it stays on the Apple ID until the owner removes it there (ADR 0015). Rotating the key is what locks it out: the devices the owner keeps move to a new vault, and the old vault stops taking anything.

## Decision

- **A rotation makes a new vault**, with a new random ID and a new 256-bit key, so a new enrollment secret, record key, store-name key (ADR 0016) and recovery key. Nothing is re-sealed in place: a new vault ID is a new Durable Object on a relay and a new zone on iCloud, so old-key records never mix with new ones, and the store's version counters start over with the existing epoch path (every record back to version 0, a pull from the start and a full upload, ADR 0002 risk 8).
- **The old vault is retired**, never deleted first: the store keeps the retirement and names the successor's ID, which is not secret. Every device that still holds the old key finds the retirement at its next connect, or at its next push or pull, and stops with `E_SYNC_VAULT_ROTATED`.
- **No new key ever travels sealed under the old key.** Whoever holds the old key could open it. The new key reaches a remaining device only through what the old key does not open: a pairing code or the new recovery key on a relay (ADR 0008), the iCloud Keychain on iCloud (ADR 0015).
- **The old key opens nothing new.** It names the old vault only, which takes no more writes, enrollments or pulls.

## On a relay

### Who can rotate

A device enrolled in the vault whose owner enters the relay's secret, the one that created the vault (ADR 0004). Both steps on the relay need it: making the successor is a vault creation, and retiring the old vault is the relay owner's act too. The device uses the secret for those requests and does not keep it. So a stolen device that is still enrolled, or enrolled again with the old key, can neither rotate the owner out of their own vault nor retire it for a successor of its own: it never held the relay secret, and a device token retires nothing. Rotation is not gated by the licence: taking access away is never locked (ADR 0008). The new vault's sync is, like any connect.

### The relay's part

One new HTTP route, `POST /v1/vaults/<old>/retire` with `Authorization: Bearer <relay secret>` and the body `retire(successor)`. It is not a socket message, so a device token alone cannot retire a vault:

- The front checks the relay secret the way it does for `create`, before anything reaches a vault's storage. Like enrolling, the route carries no token, so the front's per-address rate limit for anonymous routes covers it.
- The successor must be a vault this relay holds that is not retired itself (`E_SYNC_NO_SUCCESSOR` otherwise), so a retire cannot name a vault nobody can join, or point two vaults at each other.
- The vault keeps `retirement(successor, at)` in a table of its own, made by the first retire, so no existing table changes. A retire on a vault already retired to the same successor answers `retired` again; one naming another successor is refused with `E_SYNC_VAULT_ROTATED` and the successor kept. So two devices rotating at once end with one successor.
- From then on the vault refuses `push`, `pull` and `enroll` with `E_SYNC_VAULT_ROTATED`, the error carrying `successor`. Tokens still authenticate, so a socket opens and its `welcome` carries `retired: <successor>`; listing and removing devices still work.
- After the retire the relay sends `changed` to the vault's sockets, so a device that is connected pulls at once and is refused, instead of waiting for its next edit.
- The `welcome` of a relay that can retire carries `rotation: 'on'`. A device checks it before it makes anything, so an older relay costs nothing (`E_SYNC_RELAY_OUTDATED`) and leaves no successor behind.
- Pairing on a retired vault is not refused by the relay: an offer for the old vault hands over a key whose vault takes no enrollment. Devot does not show a code for a retired vault.

### The rotating device

Each step is kept before the next, so a rotation that stops anywhere either finishes or leaves the old vault as it was:

1. **Make the key.** A new vault goes into the device-only keychain under its own account (`vault-next`), beside the old one, and the sync settings record `rotating: { from, to }`. A rotation started again takes the waiting key instead of making another.
2. **Make the successor** on the relay with the relay's secret (`create`); a successor that exists already, from an earlier try, is enrolled in with the new key's enrollment secret instead. Its token goes to its own account (`device-next`). A wrong relay secret stops here, with nothing retired.
3. **Retire the old vault** with the relay's secret, naming the successor. Retiring comes before the upload: until it, anyone holding the old key can enroll in the old vault and read what is pushed there.
   - Another device won the race: its successor is named in the refusal. This device drops its own new key and token, records the winner as the old vault's successor and stops with `E_SYNC_VAULT_ROTATED`, like any other device. The successor it made stays on the relay empty, with one device, until the relay drops it (Clearing the relay).
4. **Switch.** The vault item takes the new key, then the device-only token item takes the successor's token, then the settings forget `rotating`, and the `-next` items go. The recovery key is recorded as saved per vault ID, so the new one is on offer. The old key is gone from this device.
5. **Upload.** The engine connects to the successor, finds a new epoch and uploads the whole library. The new recovery key is offered until the owner says it was saved, as for a new vault.

### Who has not joined yet

The old vault still lists its devices once retired, so the rotating device can name those that still have to join (#644):

- At the switch, before the successor's token takes its place, the device keeps its old token in a device-only item of its own (`device-retired`). That token opens only the retired vault, which takes no pushes, pulls or enrollments, so keeping it opens nothing new.
- Settings > Sync on the rotating device lists the successor's devices, then the old vault's other devices, each with the day it was added and marked as not joined yet.
- The kept tokens are recorded for the successor they were kept for, and count only while the device holds that successor.
- When the same device changes the key again, it keeps the earlier old tokens with the new one, since their devices have not joined the newest vault either; Settings then lists the devices of every old vault in that chain. A device of an earlier old vault cannot join the newest vault in its place, since its vault was retired for another successor: it leaves its vault (ADR 0008, Leaving a relay vault) and joins as a device with no vault, and the owner removes its old row.
- A device that joins the successor of a key change another device made, in place of a vault it had itself retired, forgets the tokens it kept for that earlier change: the device that made the newer change lists the devices still to follow.
- A device that joins the successor in place of the retired vault, with a pairing code or the new recovery key, then removes itself from the retired vault with its old token, so it leaves that list. A removal that fails is not tried again; the device then shows twice, joined in the successor and not joined in the old vault, until the owner removes the old row.
- Remove on a device not joined yet removes it from the old vault that holds it, which only takes it off the list: the lost device, or one the owner no longer uses. A device no old vault holds any longer, as one that joined while the list was open, counts as removed.
- A token goes once no other device is left in its old vault, when the relay no longer takes it (this device's old row removed, or the vault gone), or with Leave This Vault. An old vault the relay does not list that time, as when it cannot be reached, lists none of its devices and keeps its token.
- The list is a guide, not an access check. A device that holds the old key and a token nobody revoked, the lost one included, can still remove devices of the old vault, this device's old row too, which ends the list; it can neither join the successor nor change what the successor lists.
- A device that left the old vault without joining (ADR 0008, Leaving a relay vault) keeps its row there, and the owner removes it from the list.

A connect that finds `rotating` with a successor token waiting reads the old vault's `welcome`. Retired for this successor: the device finishes step 4 on its own. Retired for another: it lost the race, as in step 3. Not retired: retiring needs the relay secret, which the device does not keep, so the old vault syncs on and the waiting key and token stay; the next rotation, with the secret, takes them and goes on from step 3.
If the relay dropped the waiting successor meanwhile (Clearing the relay), the retire is refused with `E_SYNC_NO_SUCCESSOR`: the device makes the successor again with the waiting key (`I_SYNC_SUCCESSOR_GONE`) and retires for it.
With no token waiting, the old vault was never retired: the waiting key and the record are dropped (`I_SYNC_ROTATION_DROPPED`) and the old vault syncs on.
If a successor was made but its token was lost, that successor stays on the relay, empty, until the relay drops it.

### Clearing the relay

A retired vault's records serve nobody: the relay refuses every pull, and every device holds all its records (ADR 0002).
A successor that lost the race, or whose token was lost, holds nothing and is reached by nobody.
The relay clears both on its own, with no new message, so it works for every build, including the released ones and a device that is offline for good.

- **A retired vault is wiped.**
  Right after the retire, the relay deletes its records and their chunks, the oldest first, in slices of at most 1,000 rows.
  A retire from before wiping existed is wiped at the vault's next connection on a Durable Object, and at the next sweep under Node.
- **The wipe is counted** like any write: the rows it deletes go into the vault's rows written, each slice counts one request, and the stored bytes and file bytes fall with it, so `usage` shows the vault empty once it is done.
- **The wipe keeps to a quarter of the daily rows cap** (`WIPE_SHARE`), counting what the vault wrote that day already.
  The successor's upload runs in the same days and the Workers Free limits are the account's, so a wipe never takes the upload's share; what does not fit waits for 00:00 UTC.
  A relay without the cap wipes slice after slice at once.
- **The wipe keeps the vault**: its `vault` row, its devices and their tokens, the `retirement` row and the counters.
  Old tokens still open a socket and learn the successor from the welcome, the old key still enrolls nowhere, and a retire naming another successor is still refused.
- **An abandoned vault is dropped**: one that holds no record, has at most one device, is not retired and was never named the successor in a retirement, and that no device connected to for 90 days (`ORPHAN_AGE_MS`).
  Dropping deletes all its storage; a later connection gets `E_SYNC_NO_VAULT`, as for a vault that does not exist.
- **A socket open at the sweep counts as a connection**, so a device that stays connected on an empty library keeps its vault however long the socket lives.
- **A retire's check of its successor counts as a connection** too: the front checks the successor before it retires the old vault and records the predecessor only after, and a sweep in between would otherwise drop a successor that waited 90 days and leave the old vault retired for a vault that is gone.
- **Why those conditions**: a successor that lost the race or whose token was lost matches all of them, since its one device never connects to it.
  A vault in use does not: its first sync uploads the library, a successor that won is named in the retirement, and a device on an empty library still connects.
  The relay keeps the time a device last connected, at most once a day and only while the vault matches, in a `standing` table made on first need, beside the vault the retirement named it the successor of; a vault from before it counts from its creation.
  Ninety days is long: a device kept away from the relay for that long with nothing to sync loses only an empty vault, and joins or creates one again.
- **The front records the successor**: after a retire is answered `retired`, the front tells the successor which vault it succeeds, and the first one named stays.
  A retire answered `retired` again records it again, so a relay that stopped between the two steps finishes at the next try.
- **On a Durable Object**, the vault's alarm does the sweeping: a creation sets it for 90 days on, a connection sets it when none is set, a retire sets it for now, and each sweep sets the next one.
  A vault from before this relay version gets its alarm at its next connection; one that never gets one stays.
- **Under Node**, the relay sweeps every vault file at start and every hour, and a retired vault at once.
- **A rotation waiting for the relay secret** may find its successor dropped, if months pass before the owner enters the secret again; the rotating device then makes the successor again with the waiting key (The rotating device).

### The other devices

- A device that connects to a retired vault, or whose push or pull is refused with `E_SYNC_VAULT_ROTATED`, records the successor's ID (`rotated: { vault, successor }` in its sync settings) and stops. Its notes stay, and so do its unsynced changes.
- Settings > Sync says the key was changed on another device and offers the two ways in: a pairing code from a device that already moved, and the new recovery key.
- A join may replace the held vault only when the held vault is recorded as retired and the joined vault is its recorded successor. A join with the old key on a device that recorded the retirement is refused with `E_SYNC_VAULT_ROTATED`, though its old token still opens a socket. Every other rule of ADR 0008 stands: another vault is still never replaced. The relay says which vault succeeded, but cannot hand over its key: the offer opens only under the code's key, and the recovery key comes from the owner. A relay that names a false successor only makes the join refuse.
- On joining, the device's whole library goes up to the successor (a new epoch), so changes it made after the rotating device's last pull reach the others. Nothing on any device is lost: every device holds all its records (ADR 0002).
- A device offline during the rotation finds the retirement when it next connects, whenever that is: the retirement is kept for good.
- A device removed before the rotation, which holds a revoked token, cannot connect to learn the successor, and so cannot join it: it stays out. To let it back in, its owner leaves the vault on it (ADR 0008, Leaving a relay vault), which forgets the old key and token there, and then joins the successor with a pairing code or the new recovery key, as a device with no vault. Leaving is also the way out for any device stuck on a vault it cannot use, such as one retired for a successor that was lost.

### What the removed device can still do

- **Read new records:** no. They are in the successor, sealed under a key it does not hold, under store names it cannot compute (ADR 0016), and enrolling there needs the new key's enrollment secret.
- **Write records others accept:** no. The old vault refuses pushes from anyone; the successor needs a token it cannot get, and records it sealed would not open.
- **Join again with the old key or the old recovery key:** no. Both name the old vault, which refuses enrollment for good.
- **Read the old vault's records:** the relay refuses pulls from the retire on and wipes them right after it (Clearing the relay), so only someone holding both the relay's storage and the old key, before the wipe ends, reads them; those are the records the device held anyway, plus what other devices pushed between its removal and the retirement. Rotating soon after removing keeps that short.
- **Hide the retirement from an offline device:** only together with the relay, which then also hands out the old records. A relay that colludes could keep an offline device pushing to the old vault until the owner rotates on it; that is outside what a relay is trusted not to do (ADR 0002, risk 10), and Settings on the rotating device lists the devices of the successor, and those of the old vault that have not joined it, so a missing one shows.

### Older builds

- An older build connecting to a retired vault ignores `retired` in the welcome. Its pushes and pulls are refused with a code it does not know, which it reports as a relay failure and retries with backoff; it writes nothing anywhere and keeps its notes. Once updated it finds the retirement and asks to join again.
- An older relay has no `rotation` in its welcome, and Devot does not offer to rotate on it.

## On iCloud

### Who can rotate

Any device in the vault, from Settings > Sync on the Mac.
The Apple ID decides who is in (ADR 0015), so rotating there only helps once the lost device is off the Apple ID, or has no iCloud Keychain: a device still on both reads the new handover item like any other.
Settings says so before it rotates, and Change Key is the confirmation; no secret is asked, since CloudKit's private database takes writes from the Apple ID's devices only.
Rotation is not gated by the licence, as on a relay.

### What zone `devot` holds for it

- A successor record (`DevotSuccessor`) named `successor-<old ID>-<new ID>`, one per rotation, so the record of a rotation that lost the race never stands for the winner's.
  It holds `sealed`, the new vault's ID sealed under the old key as a record of the new ID under its own label, and `mac`, HMAC-SHA256 over both IDs under a key derived from the new vault's key (HKDF-SHA256, its own label).
  A device holding the old key opens the first; only the holder of the new key could make the second.
- `current`, moved from the old vault to the new under `.ifServerRecordUnchanged`: the compare-and-swap is what decides between two rotations at once.

### The rotating device

Each step is kept before the next, and none needs a secret, so a rotation that stops anywhere carries on at the next connect from where it stopped:

1. **Make the key.** The new vault goes under `vault-next` and the sync settings record `rotating: { from, to }`. A rotation started again takes the waiting key.
2. **Make the successor's zone** `devot-<new ID>` and its epoch `meta-<new ID>`, saved only if absent.
3. **Save the successor record** for the old vault.
4. **Move `current`** to the new vault against the `current` that names the old one.
   - Another rotation moved it first: this device deletes its new key and what it made (its zone, epoch and successor record, never while `current` names them) and follows the winner like any other device.
   - With no `current`, the vault was left meanwhile: the rotation is dropped.
5. **Write the handover item** with the new vault; a failure is logged, and each connect rewrites an item that names another vault while `current` names this one (ADR 0015).
6. **Switch.** The device-only vault item takes the new key, then the settings sync the new vault through iCloud, forget `rotating`, and the `-next` item goes. A switch that stops between the two is finished at the next connect, which finds the held vault recorded as the successor of the vault the settings name.
7. **Delete what is left of the old vault:** zone `devot-<old ID>` with its records, then its `meta-<old ID>` and its device rows in zone `devot`.
   The successor record stays, for a device that was offline.
   Until it succeeds, the new vault's iCloud state keeps `retired: <old ID>`, and each connect tries again.

The next connect finds the new epoch and uploads the whole library; the new recovery key is offered until the owner says it was saved.
The upload comes after the old zone goes: every device holds all its records, so deleting first loses nothing and stops the other devices' pushes to the old vault sooner.

A connect that finds `rotating` reads `current`.
Naming the old vault, with the key waiting: the rotation carries on from step 2.
Naming the new vault: it carries on from step 5; if the key was lost, the record is dropped and the device follows like any other.
Naming a third vault: it lost the race, as in step 4.
Naming none: the record and the waiting key are dropped (`I_SYNC_ROTATION_DROPPED`).

### The other devices

- Each connect fetches `current` with the vault's epoch, in one request.
  When it names another vault, and the successor record of the held vault for that vault opens under the held key and names it, the device records `rotated: { vault, successor }`.
- When the handover item holds that vault and the record's MAC holds under its key, the device switches on its own (device-only item, then settings) and its next connect uploads the whole library under the new epoch.
  It never shows the new recovery key: it joined the successor, it did not make it.
- When the handover item has not arrived, holds another vault or the MAC does not hold, the device stops with `E_SYNC_VAULT_ROTATED`, and Settings offers the pairing code through iCloud and the new recovery key; either may replace the held vault for that successor only (`E_SYNC_VAULT_EXISTS` for any other).
  Each connect checks again, so a handover item that arrives later still lets it follow on its own.
- Without a successor record that opens, `current` naming another vault keeps meaning what ADR 0015 says: the device takes nothing on its own.
- A device that was offline finds the zone gone and `current` naming the successor; the successor record is checked before the zone's loss is read as a deletion, so it follows the same way.
- A device two rotations behind finds no successor record for its vault and the one `current` names, so it takes nothing on its own.
  Its owner leaves the vault on it with its recovery key (ADR 0015, Leaving the vault), which deletes nothing the newer vault uses, and it then joins as a device with no vault.

### Older builds

An older build sees `current` naming another vault while its own zone is there and syncs on into the old zone until the rotating device deletes it; then it reports `E_SYNC_ICLOUD_DELETED`.
Its notes stay, and once updated it follows.
The record type `DevotSuccessor` is deployed to CloudKit's Production schema before the release that rotates (docs/releasing.md).

## Considered

- **Re-sealing in place under a new key generation.** It keeps the vault ID and the device tokens, but every device still on the old key that connects after the change would see a new epoch and upload its whole library under the old key into the rotated vault, including builds that do not know about generations. The store would hold records of two keys under one counter, and the old key would still enroll.
- **Leaving the new key on the relay sealed under the old key** for the remaining devices to fetch with their tokens. The relay would refuse the removed device, but the box opens for anyone with the old key and the relay's storage. Sealing the new key to each remaining device needs per-device keys pinned before the loss; that is the follow-up that lets relay devices move without pairing again.
- **Rotating or retiring without the relay secret**, on a device token alone. Any enrolled device, a stolen one included, could then retire the vault for a successor of its choosing before the owner rotates: the owner's devices would record that successor, refuse to rotate a retired vault and accept a join into nothing else, so the fleet would be locked out of its own vault. A retire over the socket, from an enrolled device, was built first and dropped for this.
- **Proving the successor with a token of it** instead of the relay secret. It would let a rotation stopped before the retire finish at the next connect without the secret, but a device that is a member of any other live vault on the relay could still retire the vault for that one. The secret is simpler to reason about; a rotation stopped there waits for the owner to enter it again.

- **A wipe asked by a device of the successor**, with its token, checked against the retirement.
  Nobody needs the records once pulls are refused, so a request adds a route and a check across two vaults for nothing, and a device that is offline for good, an older build or a lost token would never send it.
- **Wiping in the retire's own transaction.**
  A large vault would write more rows in one go than the daily limits allow, on the days the successor's upload needs them.
- **Dropping an empty vault by its age alone.**
  A device that set up sync on an empty library would lose its vault while it is still in use; the last connection tells the two apart.

## Consequences

- ADR 0002: a relay vault can be retired, with the relay secret only; it keeps a `retirement` table, refuses `push`, `pull` and `enroll` once retired, and its welcome says so.
  The relay wipes a retired vault's records within a share of the daily rows cap and drops a vault left empty and unused for 90 days.
- ADR 0008: "Locking out a lost device for good needs a new vault key" is this ADR. A join may replace a held vault that is retired, for its successor only. Leaving a relay vault, which ADR 0008 now records, lets any other vault be joined.
- ADR 0015: locking a device out of an iCloud vault is removing it from the Apple ID and then rotating, as above.
- ADR 0016: a rotation is a new vault, so every store name changes with it; a store can link old and new names only by timing and sizes, as after the move to store names.
- Follow-ups: per-device keys so relay devices follow without pairing again (#642). Leaving a relay vault, the recovery path for a stuck device (#646), is built (ADR 0008), and so are listing on the rotating device the old vault's devices that have not joined the successor yet (#644, above) and clearing the relay of a retired vault's records and of an abandoned successor (#643).
