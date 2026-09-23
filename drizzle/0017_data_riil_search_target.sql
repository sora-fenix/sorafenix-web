-- Give the one live campaign a real `campaigns.target`, and a cursor to walk it
-- with (ADR 0001 §7, migration 3).
--
-- Hand-written and data-only, like 0007, 0008 and 0010: it creates no object and
-- drizzle-kit would emit nothing for it. What it moves is the last piece of
-- tenant identity still living inside n8n -- the KEYWORDS and KOTA literals in
-- the Search Plan node -- into the row that already exists to hold it. After
-- this, `data-riil` is swept because of what is in its campaign row, not because
-- of what is hard-coded in a workflow.
--
-- THE TARGET IS COPIED, NOT RETYPED. Every keyword and location below was read
-- out of `n8n/workflows/sora-lead-hunter.json`, node "Search Plan", and run
-- through `parseTarget` / `canonicalizeTarget` / `fingerprintTarget` from
-- `src/lib/scraping/target.ts`. The arrays are stored in canonical form -- NFC,
-- trimmed, deduped, codepoint-sorted -- so what is in the column is exactly what
-- gets swept. 12 keywords x 25 locations x 5 pages = 1500 searches per lap.
--
-- THE FINGERPRINT WAS COMPUTED, NOT GUESSED. `fingerprintTarget` over the target
-- below returns
--   fe5dc98c5a24ddb24213dac09bbfc775d690e40a3612159407faa516e1e6520d
-- and `buildSearchSpace` returns 1500 items. A wrong value here would not fail:
-- the planner would see a fingerprint mismatch, quietly reset the cursor to
-- position 0 on its first run, and nobody would ever know the seeded position
-- had been discarded. `notes` is deliberately absent from the hash (Amendment 1),
-- so the note below can be reworded without restarting the lap.
--
-- `lap = 1`, not 0. The space has already been walked -- by the calendar-modulo
-- slices this ADR deletes -- and `classifyTier` sends any campaign at lap 0
-- straight to `burst`, which would spend 300 searches a day re-covering ground
-- already paid for. `position = 0` is honest either way: the old n8n order and
-- the new stride permutation are different orders over the same combinations, so
-- there is no old position worth translating.
--
-- CAVEAT FOR THE OWNER: the tier is meant to follow the saturation signal, and
-- the planner cannot read that signal. ADR 0001 §6 forbids the cross-tenant plan
-- query from touching a lead, while §3 derives the signal from lead counts —
-- they contradict each other, which ADR "Amendment 2" records. `classifyTier` is
-- handed a zero sample and holds whatever tier is stored, forever, for any
-- cursor past its first lap.
--
-- So `tier` is set explicitly below rather than left at the column's 'burst'
-- default. The reasoning is at the insert itself. Owner decision, 2026-09-23:
-- patch this one campaign now, resolve the contradiction for every tenant in
-- step 3 by moving the saturation counters onto the cursor row.
--
-- WHAT THIS IS SCOPED TO, and it is narrower than "the data-riil workspace":
-- a RUNNING campaign in that workspace whose `target` is NULL. Both extra
-- conditions matter once this file is immutable.
--
--   * `target->>'version' is null` matches a target that is blank OR that is not
--     a versioned SearchTarget at all. It can never touch one that IS versioned.
--     Two rejected alternatives, and the reasoning is the whole point:
--
--     "not version 1" (`coalesce(target->>'version','') <> '1'`) would rewrite a
--     hand-authored v2 target the first time it ran, restarting somebody's lap
--     and re-billing their space, with the guard only stopping the SECOND run.
--
--     "is null" -- fill a blank only -- is safe but does not do the job. This
--     campaign holds a pre-ADR `{note, source}` target, so a replay onto any
--     snapshot taken before this migration would match nothing and leave the
--     campaign unswept. That value is not somebody's authored target worth
--     protecting: it has no `version`, so `parseTarget` rejects it, the campaign
--     is skipped as `invalid_target`, and it can never be swept while it stands.
--     Protecting it protects nothing and costs the migration its purpose.
--
--     The version key is what separates "authored under this ADR's schema" from
--     "pre-ADR junk", so that is what the predicate tests.
--   * `status = 'running'` because a target is what the planner sweeps. Writing
--     one into a draft or archived campaign is writing a sweep nobody asked for,
--     which starts the day somebody sets that campaign running.
--
-- The workspace has exactly one campaign today -- verified before this file was
-- finalised -- so the two predicates change nothing about what this does here.
-- What they buy is a database where somebody has since added a second campaign:
-- a draft, an archived one, or any campaign already carrying a versioned target
-- of its own, is out of reach. A second RUNNING campaign with a blank or pre-ADR
-- target would still be filled -- deliberately, since such a campaign sweeps
-- nothing until it has one -- and that is the whole remaining blast radius.
--
-- Idempotent, like 0007 and 0010: a filled target no longer matches, and the
-- cursor insert defers to the unique index on `campaign_id`. Re-running changes
-- nothing. On a database without the `data-riil` workspace -- CI, a fresh
-- clone -- both statements match zero rows.

update campaigns c
set target = jsonb_build_object(
      'version', 1,
      'endpoint', 'places',
      'keywords', jsonb_build_array(
        'aksesoris hewan peliharaan',
        'dokter hewan',
        'grooming hewan',
        'klinik hewan',
        'penitipan hewan',
        'pet grooming',
        'pet shop',
        'petshop',
        'toko anjing',
        'toko hewan peliharaan',
        'toko kucing',
        'toko pakan hewan'
      ),
      'locations', jsonb_build_array(
        'Batu',
        'Gresik',
        'Gubeng Surabaya',
        'Kenjeran Surabaya',
        'Krian Sidoarjo',
        'Lakarsantri Surabaya',
        'Malang',
        'Malang Kota',
        'Manyar Gresik',
        'Mojokerto',
        'Mulyorejo Surabaya',
        'Rungkut Surabaya',
        'Sidoarjo',
        'Sukolilo Surabaya',
        'Surabaya',
        'Surabaya Barat',
        'Surabaya Pusat',
        'Surabaya Selatan',
        'Surabaya Timur',
        'Surabaya Utara',
        'Taman Sidoarjo',
        'Tandes Surabaya',
        'Waru Sidoarjo',
        'Wiyung Surabaya',
        'Wonokromo Surabaya'
      ),
      'pages', jsonb_build_array(1, 2, 3, 4, 5),
      'resultsPerRequest', 10,
      'country', 'id',
      'language', 'id',
      'notes', 'Disalin dari node Search Plan di workflow sora-lead-hunter (ADR 0001).'
    ),
    updated_at = now()
from workspaces w
where w.id = c.workspace_id
  and w.slug = 'data-riil'
  and c.status = 'running'
  and c.target->>'version' is null;
--> statement-breakpoint

-- `tier` is set explicitly to 'maintenance' rather than taking the column
-- default of 'burst', and that is not a detail.
--
-- ADR §3 classifies a tier from a saturation signal — `new` falling while
-- `merged` climbs — which is derived from LEAD counts. ADR §6 forbids the
-- cross-tenant planner query from touching a lead, contact or message. Those two
-- cannot both hold, so `classifyTier` can only ever fire its `lap === 0` branch
-- and every cursor past its first lap keeps whatever tier it was stored with,
-- forever. See "Amendment 2" in the ADR.
--
-- Seeding `lap = 1` was meant to stop this campaign bursting over ground it has
-- already swept. On its own it does not: at 'burst' the campaign would be
-- planned ceil(1500 / 5) = 300 searches a day across a space whose 1500
-- combinations were fully covered in the 2026-09-07 week. At 'maintenance' it is
-- ceil(1500 / 90) = 17 a day, which is the honest reading of what
-- `pnpm leads:stats` already measured: `new` collapsed while `merged` climbed.
--
-- This is a stopgap for one known campaign, not a fix. Step 3 resolves the
-- contradiction for every tenant.
insert into scrape_cursors
  (workspace_id, campaign_id, space_fingerprint, space_size, position, lap,
   lap_started_on, tier, tier_changed_on)
select c.workspace_id,
       c.id,
       'fe5dc98c5a24ddb24213dac09bbfc775d690e40a3612159407faa516e1e6520d',
       1500,
       0,
       1,
       date '2026-09-23',
       'maintenance',
       date '2026-09-23'
from campaigns c
join workspaces w on w.id = c.workspace_id
where w.slug = 'data-riil'
  and c.status = 'running'
  -- Only a campaign carrying THIS target: the fingerprint and space size below
  -- are that target's, and seeding them beside any other one would hand the
  -- planner a position into a space the campaign is not walking.
  and c.target->>'version' = '1'
on conflict (campaign_id) do nothing;
