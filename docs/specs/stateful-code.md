# Stateful code

Part of the [architecture overview](../architecture.md).

Most defects in Devot are not wrong formulas but states the code never named.
A lifecycle spread over flags, timers, promises and stored rows has transitions nobody wrote down, and the bugs live in those transitions: a late answer, a failure path, a close in the middle.
This spec holds the rules that keep such state explicit, and how to look for what slipped through.

## How these rules were found

An audit of the whole code base looked for implicit state machines: a mode or phase the code tracks without one state value and one place that decides its transitions.
It read the code slice by slice (core data, core features, the editor, the renderer, Rust storage and sync, the native screens, Swift, the licence Worker and relay, the app lifecycle) and once more across layers, for protocols between a window, the core worker, Rust and Swift.
Each candidate was re-read by an independent verifier that traced every claimed risk to lines of code, a completeness pass searched for what the slices missed, and a second checker tried to refute each surviving risk against the current code.
Of 272 machines, 166 had a risk the first verifier confirmed; the second checker refuted most of them, and 73 defects survived as issues #793 to #865.
The rules below are the patterns those 73 defects share.

To repeat the audit on a change, ask of each piece of state it adds or touches:

- What are its states, and where is each transition written?
- Which events can arrive in each state, including late answers, failures, a close, a reload and a second window?
- Which state does each failure, cancel or teardown leave behind?
- Which other layer holds a copy, and what keeps the two in step?

## One value, one owner

A lifecycle with more than two phases is one tagged union (TypeScript) or enum (Rust, Swift), not a set of booleans, nullable fields and sentinels.
One transition function changes it, and every caller goes through that function.
Illegal combinations then cannot be written, and a review can read every transition in one place.
Examples: the sync engine's connection and pass (#798), the date picker's open and saving (#833), a backup restore (#858), what is speaking (#846), a note window's live, trashed or purged state (#809).

## Answers carry who asked

An asynchronous answer applies only to the request that asked for it.
Each request carries a generation, round, request ID or target, and the answer is dropped when the state has moved on since.
A pass captures the connection's generation (#798); a save reads its drafts at send time and is serialised behind earlier saves (#831); a context menu's pick is bound to the popup that opened it (#841); a quit's answers carry its round.
A read that races an event subscribes first and ignores a read reply once an event has arrived (#843).

## Every exit resets

Failure, cancel, unmount, navigation, a hidden page and a closing window are transitions too, and each one ends the state it leaves.
Timers are cleared on every exit, not only on the success path (#811, #817, #825).
A held intent is dropped when its screen goes (#815), a press ends on cancel and on a window-level release (#836), and a request for something that is no longer there expires (#835).
A component's local state that belongs to one note is cleared when the note changes (#822, #838).
A process that cannot start its core still answers the questions other processes ask it (#795, #797).

## Read, change and write in one turn

Read-modify-write of shared state happens under the lock, transaction or turn that owns it, never around it.
Writers of a settings file go through an update that re-reads under the write lock and re-checks its precondition there.
Work that follows a rename runs inside the rename's turn (#804); a key rotation holds the membership lock for its whole run (#844).

## Persist the step before acting on it

A multi-step change that must survive a failure or a quit is one storage transaction, or it records the step it is in, in the same transaction as the step, so a retry resumes it (#800, #803, #862).
Memory changes only after the write it mirrors has landed, so a refused write leaves memory and storage agreeing (#852, #853).

## Flush or hand over before teardown

Work held for later (a coalescing timer, a pending clipboard clear, an unsaved manifest, a queued announcement) is flushed or handed to an owner that outlives the page or the setting before that page or setting goes (#794, #847, #856).
A stop wakes its loop without depending on what it is removing (#855).
A quit that is called off restores everything the quit stopped (#796, #842).

## A failure is never reported as success

A write that was dropped rejects instead of resolving (#801).
A call that fails releases what it holds, through a finally (#806).
A user action that cannot run says why instead of doing nothing (#823).

## One definition for both sides of a protocol

A message or event shared by two layers has one fixture of every kind that both sides' tests read, so one side cannot add a kind the other refuses (#793).
Two readers of the same Markdown syntax share one step (#808, #810); a second reader is a second dialect.

## Positions and drafts follow their source

Offsets kept beside an editor document are mapped through every change with the association the feature needs, or kept in a range set that maps itself (#812, #813).
A form keeps the stored value apart from the user's draft: a refusal puts the draft back to the stored value, a reload replaces the draft only when nothing is in flight or queued, and a draft is committed on focus loss as well as on Return (#830, #837, #850, #863, #865).
State that several windows show lives in one store that every window reads and that announces its changes (#839).

## Testing state

A test for a state defect writes the event order down: deferred promises for answers that arrive late, fake timers for timeouts, a second window or core for cross-window cases.
It fails on the order the defect needs and passes once the transition is handled.
A transition function of the kind above is tested on its own, event by event, in addition to the behaviour around it.
