/**
 * gwctrivia.com's daily count (Chris, 10 November 2026: "i want to know daily players and returning players").
 *
 * Cloudflare Pages runs this file for /api/*, /analytics/* and the day files only (_routes.json beside it); every other
 * file is served as it is.
 * scripts/publish-test.sh copies both files into the live branch, never into the test copy.
 *
 * The game sends one note a day from each device, on its first answer (site/src/game.ts countPlay): how long since that
 * device last played. This adds it to that day's totals in the D1 database bound to the Pages project as DB, table
 * `daily`, one row a game day. Nothing else is kept: no cookie, no ID, and the internet address is never stored. The
 * Privacy page (site/src/App.tsx) says exactly this; change it the day this changes.
 *
 * Since 11 November 2026 it also counts the results screen's two buttons (Chris: "Track both buttons on analytics- copied
 * and share buttons"): game.ts countPress sends { button: "share" | "copy" } to /api/pressed, once a day for each from
 * each device, and this adds one to that day's `shared` or `copied`. The same day it began counting the On This Day tab
 * (Chris: "can we all clicks on 'on this day' to the cloudfare analytics"): { button: "otd" }, once a day from each
 * device, adds one to `on_this_day`.
 * Since 12 November 2026 the results screen's two picture buttons (the picture share card, src/shareCard.ts) send
 * { button: "picture" }, once a day from each device, which adds one to `pictured`.
 *
 * Since 12 November 2026 it also puts each day's set up at 4 a.m. by itself (Chris, after GitHub never started the
 * 4 a.m. job that morning: "You start the job now and create the fix"). Every later day waits, sealed as the site seals
 * it, in the same D1 database, table `held_days`; days/held.json on the site names each one's SHA-256 and day 1's date.
 * A request for days/N.bin comes here (_routes.json): the site's own file when it has one, otherwise, once day N's
 * 4 a.m. Eastern has come, the held copy whose hash matches the list. Before then, or when no matching copy is stored,
 * the answer is the site's own page, as it always was, and the game shows "New set loading". scripts/publish-test.sh
 * stores the held days through /api/day/N after each publish (scripts/upload-held-days.mjs); a copy is taken only when
 * its hash is on the list, so nothing else can be stored, and nothing is ever read back before its day. The 4 a.m. job
 * (.github/workflows/daily-publish.yml) still copies each day onto the site too; either one is enough.
 *
 * Read the totals in Cloudflare: Storage & databases → D1 SQL database → gwctrivia-counts → the `daily` table.
 *
 * Or at gwctrivia.com/analytics (src/AnalyticsDashboard.tsx; Chris, 11 November 2026: "Yes, build it", after asking for
 * graphs and monthly totals): that page POSTs { key } to /api/counts and gets every row of `daily` back. The key is a
 * random 64-character string kept only in site/analytics-page.json, which reaches the browser sealed under the site's
 * password (analytics.json); this file holds only its SHA-256, so reading this file does not give the counts away.
 */

// what the note says → the column it adds one to (a fixed list: nothing a player sends ever becomes SQL)
const BACK = {
  new: "new_players",
  yesterday: "back_from_yesterday",
  "this-week": "back_within_a_week",
  longer: "back_after_longer",
};
const BUTTON = { share: "shared", copy: "copied", otd: "on_this_day", picture: "pictured" };

// made the first time a note arrives, if it is not there yet
const SCHEMA = `CREATE TABLE IF NOT EXISTS daily (
  date TEXT PRIMARY KEY,
  players INTEGER NOT NULL DEFAULT 0,
  returning_players INTEGER NOT NULL DEFAULT 0,
  new_players INTEGER NOT NULL DEFAULT 0,
  back_from_yesterday INTEGER NOT NULL DEFAULT 0,
  back_within_a_week INTEGER NOT NULL DEFAULT 0,
  back_after_longer INTEGER NOT NULL DEFAULT 0,
  shared INTEGER NOT NULL DEFAULT 0,
  copied INTEGER NOT NULL DEFAULT 0,
  on_this_day INTEGER NOT NULL DEFAULT 0,
  pictured INTEGER NOT NULL DEFAULT 0
)`;
// columns added after the table was first made, added to a table that lacks them
const ADDED = ["shared", "copied", "on_this_day", "pictured"];

/** Runs one count; makes the table, or adds a missing column, the first time it is needed, and tries once more. */
async function run(env, statement) {
  try {
    await statement.run();
  } catch (e) {
    const why = String(e);
    if (/no such table/i.test(why)) await env.DB.prepare(SCHEMA).run();
    else if (/no such column|has no column/i.test(why)) {
      for (const c of ADDED) {
        await env.DB.prepare(`ALTER TABLE daily ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`).run().catch(() => {});
      }
    } else throw e;
    await statement.run();
  }
}

/** The note's one field, when the note is short, well formed and names one of `allowed`; null otherwise. */
async function noteField(request, field, allowed) {
  try {
    const text = await request.text();
    if (text.length > 200) return null;
    const value = JSON.parse(text)[field];
    return typeof value === "string" && Object.hasOwn(allowed, value) ? value : null;
  } catch {
    return null;
  }
}

/** The game's date, as game.ts reckons it: US Eastern, turning over at 4 a.m. */
function gameDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const back = Number(parts.hour) < 4 ? 86_400_000 : 0;
  return new Date(date - back).toISOString().slice(0, 10);
}

const answer = (status) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** The game's day number today: 1 on day 1's date (`firstDate`). */
function dayNumber(firstDate, now = new Date()) {
  return Math.round((Date.parse(gameDate(now)) - Date.parse(firstDate)) / 86_400_000) + 1;
}

const HELD_SCHEMA = `CREATE TABLE IF NOT EXISTS held_days (
  day INTEGER PRIMARY KEY,
  sha TEXT NOT NULL,
  body BLOB NOT NULL
)`;
const MAX_DAY_BYTES = 1_000_000;

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isPage = (r) => (r.headers.get("content-type") ?? "").includes("text/html");

/** days/held.json from the site: { firstDate, version, days: { "<n>": "<sha256>" } }, or null when it is not there. */
async function heldList(request, env) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/days/held.json", request.url)));
    if (!r.ok || isPage(r)) return null;
    const list = await r.json();
    if (typeof list?.firstDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(list.firstDate)) return null;
    return list.days && typeof list.days === "object" ? list : null;
  } catch {
    return null;
  }
}

/** Day n's held copy, when one is stored and its hash is `want`; null otherwise. */
async function storedDay(env, n, want) {
  if (!want) return null;
  let row;
  try {
    row = await env.DB.prepare("SELECT sha, body FROM held_days WHERE day = ?1").bind(n).first();
  } catch {
    return null; // no table yet
  }
  if (!row || row.sha !== want) return null;
  const body = new Uint8Array(row.body);
  return (await sha256(body)) === want ? body : null;
}

/** days/N.bin: the site's own file, or after day N's 4 a.m. the held copy, or else the site's own answer. */
async function serveDay(request, env, n) {
  const site = await env.ASSETS.fetch(request);
  if ((site.ok && !isPage(site)) || !env.DB) return site;
  try {
    const list = await heldList(request, env);
    if (!list || n > dayNumber(list.firstDate)) return site;
    const body = await storedDay(env, n, list.days[n]);
    if (!body) return site;
    return new Response(body, {
      headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate" },
    });
  } catch {
    return site;
  }
}

/** POST /api/day/N with day N's sealed file: stored only when its hash is the one days/held.json names for day N. */
async function holdDay(request, env, n) {
  const list = await heldList(request, env);
  const want = list?.days?.[n];
  if (!want) return answer(404);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_DAY_BYTES) return answer(413);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_DAY_BYTES) return answer(400);
  if ((await sha256(body)) !== want) return answer(409);
  try {
    let had = null;
    try {
      had = await env.DB.prepare("SELECT sha FROM held_days WHERE day = ?1").bind(n).first();
    } catch (e) {
      if (!/no such table/i.test(String(e))) throw e;
      await env.DB.prepare(HELD_SCHEMA).run();
    }
    if (had?.sha === want) return answer(204);
    await env.DB.prepare("INSERT OR REPLACE INTO held_days (day, sha, body) VALUES (?1, ?2, ?3)")
      .bind(n, want, body)
      .run();
  } catch {
    return answer(500);
  }
  return answer(201);
}

/** GET /api/held-status: how many days the list holds, and how many of them are stored with the right hash. */
async function heldStatus(request, env) {
  const list = await heldList(request, env);
  const days = list ? Object.keys(list.days) : [];
  let rows = [];
  try {
    rows = (await env.DB.prepare("SELECT day, sha FROM held_days").all()).results ?? [];
  } catch (e) {
    if (!/no such table/i.test(String(e))) return answer(500);
  }
  const stored = rows.filter((r) => list?.days?.[r.day] === r.sha).length;
  const today = list ? dayNumber(list.firstDate) : null;
  return new Response(JSON.stringify({ today, held: days.length, stored }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// SHA-256 of analytics-page.json's countsKey (see the note at the top)
const COUNTS_KEY_SHA256 = "cbbca4b043666333ab300bec8a06b9564ee35e97905138a2ab4dcf829eabec7f";

/** True when the note carries the counts key. Compares the key's hash, every character, whatever matches first. */
async function holdsCountsKey(request) {
  try {
    const text = await request.text();
    if (text.length > 200) return false;
    const key = JSON.parse(text).key;
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    let differ = 0;
    for (let i = 0; i < hex.length; i++) differ |= hex.charCodeAt(i) ^ COUNTS_KEY_SHA256.charCodeAt(i);
    return differ === 0;
  } catch {
    return false;
  }
}

/** Every row of `daily`, oldest first, and the game's date today. No table yet: no rows. */
async function readCounts(env) {
  let rows = [];
  try {
    rows = (await env.DB.prepare("SELECT * FROM daily ORDER BY date").all()).results ?? [];
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
  }
  return new Response(JSON.stringify({ today: gameDate(), rows }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // gwctrivia.com/analytics (src/Analytics.tsx) with a slash after it would read its scripts from /analytics/assets/,
    // which do not exist; the page's one address is /analytics
    if (url.pathname.startsWith("/analytics/")) return Response.redirect(`${url.origin}/analytics`, 301);
    const dayFile = url.pathname.match(/^\/days\/(\d{1,4})\.bin$/);
    if (dayFile) {
      try {
        return await serveDay(request, env, Number(dayFile[1]));
      } catch {
        return env.ASSETS.fetch(request);
      }
    }
    if (url.pathname.startsWith("/days/")) return env.ASSETS.fetch(request);
    const dayApi = url.pathname.match(/^\/api\/day\/(\d{1,4})$/);
    if (dayApi || url.pathname === "/api/held-status") {
      const origin = request.headers.get("origin");
      if (origin && origin !== "https://gwctrivia.com") return answer(403);
      if (!env.DB) return answer(503);
      if (!dayApi) return request.method === "GET" ? heldStatus(request, env) : answer(405);
      return request.method === "POST" ? holdDay(request, env, Number(dayApi[1])) : answer(405);
    }
    const counts = url.pathname === "/api/counts";
    if (!counts && url.pathname !== "/api/played" && url.pathname !== "/api/pressed") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return answer(405);
    // a browser on any other site may not add to the count, or read it
    const origin = request.headers.get("origin");
    if (origin && origin !== "https://gwctrivia.com") return answer(403);
    if (!env.DB) return answer(503);
    if (counts) {
      if (!(await holdsCountsKey(request))) return answer(403);
      try {
        return await readCounts(env);
      } catch {
        return answer(500);
      }
    }

    let add;
    if (url.pathname === "/api/played") {
      const back = await noteField(request, "back", BACK);
      if (!back) return answer(400);
      const column = BACK[back];
      add = env.DB.prepare(
        `INSERT INTO daily (date, players, returning_players, ${column}) VALUES (?1, 1, ?2, 1)
         ON CONFLICT(date) DO UPDATE SET players = players + 1,
           returning_players = returning_players + ?2, ${column} = ${column} + 1`,
      ).bind(gameDate(), back === "new" ? 0 : 1);
    } else {
      const button = await noteField(request, "button", BUTTON);
      if (!button) return answer(400);
      const column = BUTTON[button];
      add = env.DB.prepare(
        `INSERT INTO daily (date, ${column}) VALUES (?1, 1)
         ON CONFLICT(date) DO UPDATE SET ${column} = ${column} + 1`,
      ).bind(gameDate());
    }
    try {
      await run(env, add);
    } catch {
      return answer(500);
    }
    return answer(204);
  },
};
