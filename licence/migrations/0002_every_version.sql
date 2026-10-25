-- A licence unlocks every version (docs/adr/0006-source-available-and-sold-once.md): it has no
-- last covered release and is never renewed, so each purchase is the first of its licence.
ALTER TABLE licences DROP COLUMN updates_until;

ALTER TABLE purchases DROP COLUMN kind;
