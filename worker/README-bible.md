# Astrogem Bible Worker (Grader "pull from lostark.bible")

A Cloudflare Worker that powers the **Grader** tab's *"Pull from lostark.bible"*
mode and the **Leaderboard**. It fetches a character page **server-side with a
browser User-Agent** (the sites return `403` to default fetchers but `200` for a
browser UA) — from [lostark.bible](https://lostark.bible) for NA/EU regions, or
from [lopec.kr](https://lopec.kr) for KR — extracts the embedded gem data
(`arkGridCores` hydration on lostark.bible; the spec-point payload on lopec.kr),
and returns every equipped astrogem as JSON:

```json
{
  "region": "NA",
  "name": "Paroxysmal",
  "gems": [
    {
      "slot": "Order Sun", "baseCost": 8, "gemType": "order",
      "willpowerLevel": 5, "orderLevel": 5,
      "effect1": "Additional Damage", "effect1Level": 5,
      "effect2": "Attack Power", "effect2Level": 5
    }
    // ... one per equipped gem (4 per core, up to 6 cores)
  ],
  "warnings": []
}
```

No Anthropic / external paid API and no secrets (the admin token is a soft gate in
the source) — but it is **not** a plain stateless fetcher anymore. It carries:

- a **KV namespace binding `CHARS`** — every fetched character is cached ~7 days,
  an `__index__` list + gzipped snapshot feed the Leaderboard, and the lookup
  **queue** (premium/free lanes) lives here too;
- a **cron trigger** (`* * * * *`) that drains the queue every minute (with a
  monthly-budget guard, a fail-streak circuit breaker, and run/off/probe modes)
  and rebuilds the leaderboard snapshot at most every ~30 min;
- **five rate-limit bindings** (`HARD_CAP`, `LOOKUP_THROTTLE`, `LB_THROTTLE`,
  `GLOBAL_GATE`, `ENQUEUE_GATE`) on the public endpoints.

The full plumbing — queue lanes, drain modes, kick fetch, breaker, every KV key
and constant — is documented in
[`../docs/how-the-queue-and-drain-work.md`](../docs/how-the-queue-and-drain-work.md).

- Files: [`astrogem-bible.js`](./astrogem-bible.js),
  [`wrangler.bible.toml`](./wrangler.bible.toml) (the KV + ratelimit + cron
  config lives here).
- This is **separate** from the Workers-AI vision Worker
  (`astrogem-vision.js` / `wrangler.toml`); they deploy independently.

## Deploy

```bash
cd worker
npx wrangler deploy --config wrangler.bible.toml
```

Wrangler prints a URL like `https://astrogem-bible.<your-subdomain>.workers.dev`.

## Enable it in the app (the one manual step)

Open [`../grader.js`](../grader.js) and set the `WORKER_URL` constant near the top
to that URL:

```js
var WORKER_URL = "https://astrogem-bible.<your-subdomain>.workers.dev";
```

Reload the Grader tab. The *"Pull from lostark.bible"* mode becomes usable (it is
shown but the button is disabled while `WORKER_URL` is empty). **Custom input** mode
works with no setup at all.

## API

| Method | Path | Query | Response |
|--------|------|-------|----------|
| `GET`  | `/`  | `?region=NA&name=Paroxysmal` | `{ region, name, gems:[...], warnings:[...] }` (KV-cached ~7 days; add `&refresh=1` to bypass the cache, `&queue=1` to enqueue on a miss, `&wait=1` to hold the request through a kick-drain, `&pos=1` for queue position) |
| `GET`  | `/`  | `?list=1` (`&fmt=2` compact) | `{ characters:[...] }` — the leaderboard snapshot |
| `GET`  | `/`  | `?status=1` | drain/queue status |
| `GET`  | `/`  | `?metrics=1&k=<token>` / `?control...&k=<token>` | owner dashboard + controls (`queue-admin.html`; gated) |
| `GET`  | `/`  | (none) | `{ ok, service, usage }` (health check) |
| `OPTIONS` | `/` | — | CORS preflight (204) |

Error responses: `{ error, ... }` with `400` (missing params), `404` (character not
found), `422` (no Ark Grid data on the page), or `502` (upstream fetch error). The
endpoint / KV-key / constant reference lives in the queue doc (§9–§11).

## How the gem data is decoded

The page embeds an `arkGridCores` array (one entry per core; each core has 4 gems).
Each gem looks like:

```
{ id:67401026, idx:0, costReduc:5, corePoints:5, opts:[{id:2002,level:5},{id:2001,level:5}] }
```

- `costReduc` → **willpower level**, `corePoints` → **order level**, `opts` → the two
  side effects `{id, level}`.
- **Effect id → name** (verified against the page's rendered per-stat *"Lv. NN"*
  totals — the sum of each stat's levels across all gems matched exactly):

  | id | effect | id | effect |
  |----|--------|----|--------|
  | 2001 | Attack Power | 2011 | Ally Damage Enh. |
  | 2002 | Additional Damage | 2012 | Brand Power |
  | 2003 | Boss Damage | 2013 | Ally Attack Enh. |

- **Cost + type from the gem `id`** (format `674 [type] 1 [shape] 2 [variant]`):
  - `gemType = id[3]`: `0` = order, `1` = chaos (agrees with the core's `base`:
    `10001–10003` Order Sun/Moon/Star, `10004–10006` Chaos Sun/Moon/Star).
  - `baseCost = 8 + (id[5] % 3)`: order shapes `0/1/2` and chaos shapes `3/4/5` both
    map `→ 8/9/10`. Cross-checked on all 24 Paroxysmal gems: every gem's two `opts`
    fall inside exactly the cost's effect pool (0 mismatches).

## CORS / security

`ALLOW_ORIGIN` is `"*"` for easy first-run testing. Before production, lock it to
your Pages origin (`TODO` at that line in the source).
