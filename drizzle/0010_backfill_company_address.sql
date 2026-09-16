-- Backfill companies.address from companies.raw.
--
-- The address always arrived with the lead and was always thrown away:
-- `normalizeLead` produced it, `insertNewLead` never wrote it, and the only copy
-- left is the untouched Serper payload under the Indonesian sheet header
-- "Alamat". Measured before this ran: 1033 of 1208 rows in data-riil have one.
--
-- Idempotent, like 0007: `where address is null` skips a row already filled and
-- never overwrites a correction someone made by hand, and the emptiness guard
-- keeps a blank string from being stored as if it were an address. `raw->>` on a
-- missing key yields NULL, which `<> ''` rejects.
--
-- Trimmed on the way in so the column holds one canonical form; a value that is
-- only whitespace stays null, because "   " is not an address.

update companies
set address = btrim(raw->>'Alamat')
where address is null
  and btrim(coalesce(raw->>'Alamat', '')) <> '';
