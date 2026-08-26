# n8n → SORA lead ingestion

How the lead hunter workflow hands its results to SORA. One signed webhook, one
direction. n8n scrapes; everything after that happens in the application.

Endpoint, payload and dedupe rules are specified in [SPEC.md](./SPEC.md) §2. This
file is the n8n side of that contract.

---

## What changes in the workflow

Replace the **Append to Sheet** node with two nodes:

```
Extract Contacts → Build SORA Payload (Code) → Send to SORA (HTTP Request)
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

## Node 1 — `Build SORA Payload`

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

const crypto = require('crypto');

// Set these two in a Set node upstream, or via n8n environment variables.
const SECRET = $env.SORA_WEBHOOK_SECRET;
const CAMPAIGN_ID = $env.SORA_CAMPAIGN_ID;

if (!SECRET) throw new Error('SORA_WEBHOOK_SECRET is not set');
if (!CAMPAIGN_ID) throw new Error('SORA_CAMPAIGN_ID is not set');

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

## Node 2 — `Send to SORA`

Type: HTTP Request

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `https://<your-host>/api/webhooks/n8n/leads` |
| Send Headers | on — `x-sora-signature` = `={{ $json.signature }}` |
| | and `Content-Type` = `application/json` |
| Send Body | on |
| Body Content Type | **Raw** |
| Body | `={{ $json.body }}` |

**Body Content Type must be Raw.** Choosing JSON here hands n8n an object to
re-serialise, and the signature stops matching. This is the single most common
way this integration breaks.

### Reaching a local machine

`http://localhost:3000` is not reachable from n8n Cloud. During development, put
a tunnel in front of it:

```
cloudflared tunnel --url http://localhost:3000
```

Use the printed hostname as the URL. The endpoint behaves identically either way.

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
