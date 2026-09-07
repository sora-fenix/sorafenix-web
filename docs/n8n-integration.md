# n8n → SORA lead ingestion

How the lead hunter workflow hands its results to SORA. One signed webhook, one
direction. n8n scrapes; everything after that happens in the application.

Endpoint, payload and dedupe rules are specified in [SPEC.md](./SPEC.md) §2. This
file is the n8n side of that contract.

---

## Running n8n locally (Docker)

The workflow is a repo artefact: `n8n/workflows/sora-lead-hunter.json`. The
instance that runs it is `docker-compose.n8n.yml`. Both are committed, because
the first copy of this workflow existed only inside one laptop's Docker volume
and died with the laptop.

```
pnpm campaign:create      # once — prints the SORA_CAMPAIGN_ID for .env.local
pnpm n8n:start            # http://localhost:5678
pnpm n8n:logs
pnpm n8n:stop
```

Two steps are manual, once per machine:

1. **Create the owner account** n8n asks for on first boot. It is local-only.
2. **Import the workflow** (Workflows → Import from File →
   `n8n/workflows/sora-lead-hunter.json`), then give `Serper Places` a
   **Header Auth** credential named `Serper API Key` — Name `X-API-KEY`, Value
   your Serper key. The key is encrypted into the n8n volume with
   `N8N_ENCRYPTION_KEY`; it never enters the repo.

### Which workspace the leads land in

**Not `maju-bersama`.** `scripts/seed.ts` owns that workspace and deletes and
rebuilds it on every run — and `pnpm test:integration` runs the seed. Leads
imported there disappear at the next suite run, silently (known issue 7).

Real leads get their own workspace:

```
pnpm workspace:create "Data Riil" --members-from maju-bersama
pnpm campaign:create --workspace data-riil
```

Put the printed id in `SORA_CAMPAIGN_ID` and restart with `pnpm n8n:start`. The
seed only ever deletes the workspace it created, so everything here survives it.

`--members-from` copies the membership rows, roles included: a workspace nobody
belongs to cannot be opened in the UI, and RLS makes that first membership row
unreachable from the browser by design (see `provision.ts`).

Without the scripts, the product's own path does the same thing: sign in at
`/login` with an email that has no membership and let provisioning create the
workspace. The magic link lands in Inbucket at http://127.0.0.1:54324.

### Where the secrets live

`pnpm n8n:start` runs compose with `--env-file .env.local`, so the container
signs with the same `N8N_WEBHOOK_SECRET` the app verifies with. One value, one
file. A second copy would drift, and a drifted secret is indistinguishable from
a malformed request: 401 `invalid_signature`, forever.

The container receives `SORA_WEBHOOK_SECRET`, `SORA_CAMPAIGN_ID` and
`SORA_WEBHOOK_URL`. Nothing sensitive is stored in the workflow JSON, which is
what makes committing it safe.

### `$env` reaches expressions, not the Code node

Self-hosted n8n sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, so `$env` works —
**but only in the main process.** Code nodes execute in a separate task runner
that is handed a filtered environment. Verified on 2.36.9:

```
main process (pid 7)   SORA_WEBHOOK_SECRET, SORA_CAMPAIGN_ID, SORA_WEBHOOK_URL, N8N_BLOCK_ENV_ACCESS_IN_NODE
task runner (pid 19)   NODE_FUNCTION_ALLOW_BUILTIN=crypto, N8N_RUNNERS_* — and nothing else
```

That is why `SORA Config` is a **Set** node and not a line of code: its
expressions are evaluated by the main process, which can see the variables. A
Code node reading `$env.SORA_WEBHOOK_SECRET` would silently get `undefined`, sign
with an empty key, and fail with a 401 that looks like a wrong secret.
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` is set on the container and does reach the
runner, so `require('crypto')` in `Build SORA Payload` works.

### Reaching the app

`docker-compose.n8n.yml` adds `host.docker.internal:host-gateway`, so the
container reaches `pnpm dev` on the host directly:

```
docker exec sora_n8n sh -c "wget -qO- http://host.docker.internal:3000/api/health"
{"ok":true,"service":"sora"}
```

**No tunnel is involved.** `cloudflared` is only needed when n8n runs somewhere
outside the machine — see *Reaching a local machine from n8n Cloud* below.

---

## Scraping at volume

One Execute sweeps **one day's slice** of a `keyword × city × page` space.
Everything you edit lives in the `Search Plan` node:

```js
const KEYWORDS = ['pet shop', 'petshop', 'toko hewan peliharaan', /* … 12 total */];
const KOTA     = ['Surabaya Pusat', 'Rungkut Surabaya', 'Sidoarjo', /* … 24 total */];
const PAGES    = [1, 2, 3, 4, 5];

const SLICES               = 6;            // day 7 repeats slice 0
const START_DATE           = '2026-09-07'; // first day of the sweep
const MAX_SEARCHES_PER_DAY = 260;          // hard ceiling on Serper credits
```

12 × 25 × 5 = **1500 combinations**, and combination *i* belongs to slice
`i % 6`. So a day runs 250 searches that are a *mix* of keywords and cities, the
whole space is covered in six days, and day 7 lands back on slice 0 — which is
how you measure whether new businesses are still appearing in ground you already
swept. Seven days costs **1750 Serper credits**; the free tier is ~2500, and an
empty result is billed like any other.

`Loop Over Searches` runs the slice one search at a time through the whole chain,
so each search POSTs its own batch with its own `idempotency_key`
(`run_{keyword}-{kota}-p{page}_{stamp}`), and one failure does not cost the
others. `Run Summary` on the loop's *done* output totals what came back.

**Serper `/places` returns 10 per request, not 20 — measured.** Four stored
executions (2026-09-01 to 2026-09-06) each put exactly 10 items into
`Split Out Places` while `num` asked for 20, and `Extract Contacts` dropped none
of them, so the shortfall is Serper and not our contact filter. `PAGES` is
therefore the only lever that gets a city past 10: `[1, 2, 3, 4, 5]` gives up to
50. `JUMLAH` stays at 20 because asking costs nothing and the extra results
would arrive without a code change if the endpoint ever honours it.

The whole space is 1500 searches × 10 = **up to 15 000 raw results** before
dedupe, spread over six days.

**A search that finds nothing is normal, and must not stop the sweep.** Roughly
one query in eight comes back `places: []` for no reason and answers normally
minutes later — `pet shop Surabaya Pusat` did exactly that on 2026-09-07. Because
`Send to SORA` is what loops back into `Loop Over Searches`, a node chain that
produces no items would end the day's sweep at the first empty query. So
`Extract Contacts` runs with **Always Output Data** and `Build SORA Payload`
always returns exactly one item — an empty batch is still posted and SORA answers
`accepted: 0`. Do not "tidy up" either of those.

**Re-running the same combination tomorrow is safe.** A new run gets a new key,
so nothing is replayed away; SORA's dedupe collapses what it has seen before,
and a merge only fills blank fields — it never overwrites a value a human
corrected. What reaches the dashboard is unique no matter how wide the sweep.

**Speed.** Serper is not the slow part: `Fetch Website` and `Fetch Contact Page`
are, at up to two page loads per business. Both ship **Deactivated**, because
across every company scraped so far website coverage is 0% and so is email.
Turn them back on when hunting email addresses — that is the only place emails
come from — and `Extract Contacts` handles either mode without another edit.

**On a schedule.** `Every morning at 08:00` is now **enabled**; set the workflow
**Active** to make it fire. n8n does *not* catch up a missed schedule, so a
laptop asleep at 08:00 is a lost day — it will appear as a zero in
`pnpm leads:stats`, not be backfilled. The stack it needs up: `pnpm db:start`,
the app on port 3000 (`pnpm build && pnpm start` — not `next dev` for a week),
and `pnpm n8n:start`.

**Reading the result.**

```
pnpm leads:stats --workspace data-riil            # last 7 days
pnpm leads:stats --workspace data-riil --days 14
```

New vs merged per day is the number that matters. New falling while merged climbs
means the ground is covered, and widening `KEYWORDS`/`KOTA` buys more than another
day does.

One thing to know before splitting work across campaigns: a company already in
the workspace gets no second lead when another campaign finds it again
(PROGRESS decision 27). With everything in one campaign this never bites.

### Applying a patched workflow to the running container

Re-importing `n8n/workflows/sora-lead-hunter.json` straight from the repo
**unbinds the Serper credential** — the committed copy carries a placeholder
credential id on purpose. Export the live workflow, apply the change, and import
back onto the **same id**; the credential stays attached.

---

## What changes in the workflow

This is what was done to the original lead-hunter export, and what
`n8n/workflows/sora-lead-hunter.json` already contains. Replace the
**Append to Sheet** node with three nodes:

```
Extract Contacts → SORA Config (Set) → Build SORA Payload (Code) → Send to SORA (HTTP Request)
```

Keep Google Sheets too if it is useful as a log — append and POST are independent.

### Why a Code node and not just an HTTP Request

The signature covers the **exact bytes** of the request body. If the Code node
signs one serialisation and the HTTP Request node re-serialises the object before
sending, the two byte streams differ — key order, whitespace and unicode escaping
all vary — and the signature never matches. The symptom looks exactly like a wrong
secret, which is why this is worth getting right the first time.

So: the Code node produces the body **as a string**, and the HTTP node sends that
string verbatim as a raw body.

---

## Node 1 — `SORA Config`

Type: Set · Mode: Manual Mapping · **Include Other Input Fields: on**

Two string fields:

| Name | Value (local Docker) | Value (n8n Cloud) |
|---|---|---|
| `webhook_secret` | `={{ $env.SORA_WEBHOOK_SECRET }}` | the literal `N8N_WEBHOOK_SECRET` from `.env.local` |
| `campaign_id` | `={{ $env.SORA_CAMPAIGN_ID }}` | the literal campaign UUID |

**The `$env` column only works self-hosted.** On n8n Cloud,
`N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults to `true` and there is no way to turn it
off — the expression fails with `access to env vars denied`, so paste literals
there instead. Either way the values arrive through this Set node, and the Code
node below never changes.

**Never put `$env` in the Code node itself**, on any deployment. Code nodes run
in a task runner with a filtered environment — see *`$env` reaches expressions,
not the Code node* above.

On a plan that has n8n Variables, `$vars.SORA_WEBHOOK_SECRET` is a better home for
the secret than a field on the canvas. The Code node below reads the Set node, so
swapping in `$vars` is a one-line change.

`Include Other Input Fields` must be **on**, or the Set node replaces each business
with the two config fields and the payload comes out empty.

---

## Node 2 — `Build SORA Payload`

Type: Code · **Mode: Run Once for All Items**

The mode matters. SORA takes one POST containing an `items` array, not one POST
per business.

```js
// ── Build SORA Payload ───────────────────────────────────────────────────────
// Maps the sheet-shaped output of Extract Contacts onto the API contract in
// docs/SPEC.md §2, then signs it.
//
// Sheet headers ("Nama Bisnis") are a presentation format. The API speaks one
// canonical shape so that n8n, CSV upload and anything added later all land in
// the same pipeline.

// `crypto` is whitelisted in the Code node on n8n Cloud, so this needs no
// NODE_FUNCTION_ALLOW_BUILTIN. Self-hosted does need it in the task runner env.
const crypto = require('crypto');

const config = $('SORA Config').first().json;
const SECRET = config.webhook_secret;
const CAMPAIGN_ID = config.campaign_id;

if (!SECRET) throw new Error('SORA Config: webhook_secret is empty');
if (!CAMPAIGN_ID) throw new Error('SORA Config: campaign_id is empty');

function clean(value) {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

const items = $input.all().map((item) => {
  const j = item.json || {};

  // Google Maps provenance, so "where did this lead come from" stays answerable.
  const cid = clean(j.maps_cid);
  const sourceUrl = cid ? `https://www.google.com/maps?cid=${cid}` : clean(j.Website);

  return {
    company_name: String(j['Nama Bisnis'] ?? '').trim(),
    category: clean(j['Kategori']),
    address: clean(j['Alamat']),
    city: clean(j['Kota']),
    website: clean(j['Website']),
    email: clean(j['Email']),
    phone: clean(j['No. Telepon']),
    whatsapp: clean(j['WhatsApp']),
    source_url: sourceUrl,
    // Everything else rides along untouched, for debugging and re-processing.
    raw: j,
  };
});

// One key per run, computed once. A retry of THIS run must reuse it — that is
// what makes a redelivery insert nothing. A new search gets a new key.
const params = $('Set Search Params').first().json;
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const slug = `${params.keyword}-${params.lokasi}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const idempotencyKey = `run_${slug}_${stamp}`;

const payload = {
  campaign_id: CAMPAIGN_ID,
  source: 'serper_places',
  idempotency_key: idempotencyKey,
  items,
};

// Sign the string that will actually be sent, and send this exact string.
const body = JSON.stringify(payload);
const signature =
  'sha256=' + crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

return [{ json: { body, signature, item_count: items.length, idempotency_key: idempotencyKey } }];
```

### One small change upstream

`maps_cid` is computed in **Normalize Place** but dropped in **Extract Contacts**.
Add it to the object that node pushes, so `source_url` above has something to use:

```js
results.push({
  json: {
    'Nama Bisnis': m.nama_bisnis || '',
    // … existing fields unchanged …
    maps_cid: m.maps_cid || '',
    dedupe_key: key,
  },
  pairedItem: i,
});
```

---

## Node 3 — `Send to SORA`

Type: HTTP Request

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `={{ $env.SORA_WEBHOOK_URL }}` — Cloud: `https://<your-host>/api/webhooks/n8n/leads` |
| Send Headers | on — `x-sora-signature` = `={{ $json.signature }}` |
| Send Body | on |
| Body Content Type | **Raw** |
| Raw Content Type | `application/json` |
| Body | `={{ $json.body }}` |

**Body Content Type must be Raw.** Choosing JSON here hands n8n an object to
re-serialise, and the signature stops matching. This is the single most common
way this integration breaks.

`Content-Type` is not added as a header by hand: *Raw Content Type* already sets
it, and setting both risks sending it twice. The route reads the raw body
regardless of what the header says — it verifies bytes, then parses.

### Reaching a local machine from n8n Cloud

Not needed when n8n runs in Docker on the same machine — see *Running n8n locally*
above, which uses `host.docker.internal`. This section is for n8n Cloud only.

`http://localhost:3000` is not reachable from n8n Cloud. During development, put
a tunnel in front of it:

```
cloudflared tunnel --url http://localhost:3000
```

Use the printed hostname as the URL. The endpoint behaves identically either way.

Two properties of a quick tunnel worth knowing before you paste the hostname into
n8n: it is **anonymous and public** — anyone with the URL reaches your dev server,
and the webhook signature is the only thing standing in front of it — and the
hostname **changes every restart**, so the URL in the HTTP node has to be updated
each time you restart `cloudflared`. Both are fine for an afternoon of wiring and
neither is acceptable as a permanent arrangement; a named tunnel or a deployed
host is the answer once this stops being a one-off.

---

## What comes back

```json
{
  "accepted": 20,
  "inserted": 17,
  "duplicates": 2,
  "rejected": [{ "index": 7, "reason": "no_contact_channel" }],
  "replayed": false
}
```

- **accepted** — items in the payload.
- **inserted** — new companies stored.
- **duplicates** — matched an existing company; fields were merged, nothing new
  was created.
- **rejected** — items that are not leads, by index. `no_contact_channel` means no
  website, phone or email survived normalisation; `company_name_missing` means the
  name was blank.
- **replayed** — true when this `idempotency_key` had already been handled. Then
  `inserted` is always 0 and no writes happened at all.

### Error responses

| Status | Body | Meaning |
|---|---|---|
| 401 | `{"error":"invalid_signature"}` | Missing, malformed, or wrong signature. Usually Body Content Type is not Raw. |
| 400 | `{"error":"invalid_json"}` | The body is not JSON. |
| 422 | `{"error":"invalid_payload", "issues": …}` | Shape is wrong; `issues` names the fields. |
| 404 | `{"error":"unknown_campaign"}` | `campaign_id` does not exist. |

---

## Dedupe: what SORA does with the items

Four strategies, in order, first hit wins (SPEC §2):

1. **domain** — `https://WWW.Toko.co.id/kontak` and `toko.co.id` are one company.
2. **phone** — every Indonesian spelling collapses to E.164 first, so
   `0812-3456-7890`, `+62 812 3456 7890` and `8123456789` all match. Landlines
   included: `(031) 876-5432` → `+62318765432`.
3. **email** — case-insensitive.
4. **fuzzy name + city** — trigram similarity ≥ 0.85, after stripping the legal
   form, so "PT Bahagia Petcare" matches "Bahagia Petcare". City must match too:
   "Toko Bahagia" in Surabaya and in Bandung are two businesses.

That threshold is strict on purpose. A one-letter typo scores about 0.82 and does
**not** merge — merging two companies that are genuinely different is not
something the product can undo, so the bias is toward leaving them separate.

**Your workflow's own `dedupe_key` is not used for identity.** It is stored in
`raw` for debugging. Identity is decided by SORA's rules, over all runs, not by a
value computed inside one run.

---

## Duplicated work, once enrichment ships

`Fetch Website` and `Fetch Contact Page` overlap with SORA's `enrich_company` job
(SPEC §3), which fetches more pages (`/kontak`, `/about`, `/hubungi-kami`),
respects `robots.txt`, and adds an LLM summary. Once that ships, both nodes can be
deleted and the workflow gets faster and cheaper. Until then they do no harm —
whatever they find simply arrives earlier.
