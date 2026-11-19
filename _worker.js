/**
 * gwctrivia.com's daily count (Chris, 10 November 2026: "i want to know daily players and returning players").
 *
 * Cloudflare Pages runs this file for /api/* and /analytics/* only (_routes.json beside it); every other file, the day
 * files included, is served as it is. Since 17 November 2026 the day files no longer come through here (Chris, asking
 * whether the site is ready for thousands of players at once): the free plan allows this file 100,000 requests a day,
 * about 10,000 players, and past that the game could not have loaded its day. A plain file has no such limit.
 * scripts/publish-test.sh copies both files into the live branch, never into the test copy.
 *
 * The game sends one note a day from each device, on its first answer (site/src/game.ts countPlay): how long since that
 * device last played. This adds it to that day's totals in the D1 database bound to the Pages project as DB, table
 * `daily`, one row a game day. Nothing else is kept: no cookie, no ID, and the internet address is never stored. The
 * Privacy page (site/src/App.tsx) says exactly this; change it the day this changes.
 *
 * Since 16 November 2026 it also adds up each question's score (Chris: "Is it possible to take stats on questions each
 * day to see the average score per question to post results after a day is done", then "Yes"): game.ts countScore sends
 * { q, score, date } to /api/scored once a device locks in an answer to that day's game, q 1 to 5 with its score 0 to
 * 100, and q 0 with the day's total, 0 to 1,000, once the fifth is in; once a question a day from each device. This
 * adds it to the table `question_scores`, one row a day and question: how many answered, the points added up, and how
 * many scored the most there is. Not the answer given, and nothing that ties one question's note to another's.
 *
 * Since 17 November 2026 the day's total (q 0) also adds one to that day's row of `score_bands`, the band of 50 points
 * its total falls in (0 to 49 is band 0, up to band 19 for 950 to 1,000), which draws the curve of everyone's totals on
 * the game's stats (Chris: "maptap give stats on its page through a dropdown menu on the top left ... can we do that?",
 * then "Yes, build it"). GET /api/today?date= answers anyone with that day's totals, never anyone's own: players so far,
 * games finished, the average total, perfect games, each question's average and share of 100s, and the bands. The date
 * may be today's or yesterday's game date only, and each answer is kept a minute (Cloudflare's cache), so a crowd
 * reading it asks the database about once a minute.
 *
 * Since 19 November 2026 GET /api/alltime answers the same totals added up over every game date from day 1 on, for the
 * stats the top left button opens (Chris: "the one from clicking on the top left button data from all time. So it's a
 * bell curve with an average of every day combined with a dot for a player that has their own average for every day
 * combined"); the results screen keeps today's. Totals only, like /api/today, and kept a minute.
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
 * When days/N.bin is not on the site, the game asks GET /api/day/N (src/lock.ts readData): once day N's 4 a.m. Eastern
 * has come, the held copy whose hash matches the list. Before then, or when no matching copy is stored, the answer is
 * a 404, and the game shows "New set loading". scripts/publish-test.sh
 * stores the held days through /api/day/N after each publish (scripts/upload-held-days.mjs); a copy is taken only when
 * its hash is on the list, so nothing else can be stored, and nothing is ever read back before its day. The 4 a.m. job
 * (.github/workflows/daily-publish.yml) still copies each day onto the site too; either one is enough.
 *
 * Once the game is open to everyone (scripts/open-site.sh, run only at Chris's word), the held days are plain JSON
 * instead of sealed, and days/held.json says so ("open": true); they are still handed out only from their 4 a.m.
 *
 * POST /api/clear-counts with { key, before, clear } (scripts/clear-trial-counts.mjs; Chris, 17 November 2026, "how to
 * clear analytics page"): how many rows of `daily`, `question_scores` and `score_bands` are dated before `before`, and,
 * only when `clear` is true, removes them, so the analytics page starts at day 1. The counts key, as for /api/counts.
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

// each question's scores, one row a game day and question (q 0 is the day's total out of 1,000)
const SCORES_SCHEMA = `CREATE TABLE IF NOT EXISTS question_scores (
  date TEXT NOT NULL,
  question INTEGER NOT NULL,
  answers INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  perfect INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, question)
)`;

// how many players' day totals fell in each band of 50 points, one row a game day and band
const BANDS_SCHEMA = `CREATE TABLE IF NOT EXISTS score_bands (
  date TEXT NOT NULL,
  band INTEGER NOT NULL,
  players INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, band)
)`;
const BAND = 50;
const BANDS = 20; // 1,000 itself goes in the last band, with 950 to 999

/** GET /api/today?date=: everyone's totals for today's game date, or yesterday's when asked, as JSON. */
async function todayStats(request, env, url) {
  const today = gameDate();
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  const date = url.searchParams.get("date") === yesterday ? yesterday : today;
  const key = new Request(`${url.origin}/api/today?date=${date}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return hit;
  // a table not made yet reads as no rows
  const rows = async (sql) => {
    try {
      return (await env.DB.prepare(sql).bind(date).all()).results ?? [];
    } catch {
      return [];
    }
  };
  const daily = await rows("SELECT players FROM daily WHERE date = ?1");
  const qs = await rows("SELECT question, answers, points, perfect FROM question_scores WHERE date = ?1");
  const bandRows = await rows("SELECT band, players FROM score_bands WHERE date = ?1");
  const byQ = new Map(qs.map((r) => [r.question, r]));
  const day = byQ.get(0);
  const bands = Array(BANDS).fill(0);
  for (const r of bandRows) if (r.band >= 0 && r.band < BANDS) bands[r.band] = r.players;
  const body = {
    date,
    players: daily[0]?.players ?? 0,
    finished: day?.answers ?? 0,
    average: day?.answers ? Math.round(day.points / day.answers) : null,
    perfect: day?.perfect ?? 0,
    questions: [1, 2, 3, 4, 5].map((q) => {
      const r = byQ.get(q);
      return r?.answers
        ? { answers: r.answers, average: Math.round(r.points / r.answers), perfectShare: Math.round((100 * r.perfect) / r.answers) }
        : { answers: 0, average: null, perfectShare: null };
    }),
    bands,
  };
  const res = new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return res;
}

/** GET /api/alltime: everyone's totals over every game date from day 1 on, as JSON: games finished, the average total,
 * perfect games, each question's average and share of 100s, and the bands, each added up over the days. */
async function allTimeStats(request, env, url) {
  const key = new Request(`${url.origin}/api/alltime`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return hit;
  // from day 1's date, so a count taken in the trial before it never shows
  const since = (await heldList(request, env))?.firstDate ?? "0000-00-00";
  const rows = async (sql) => {
    try {
      return (await env.DB.prepare(sql).bind(since).all()).results ?? [];
    } catch {
      return [];
    }
  };
  const qs = await rows(
    `SELECT question, SUM(answers) AS answers, SUM(points) AS points, SUM(perfect) AS perfect,
            COUNT(DISTINCT date) AS days FROM question_scores WHERE date >= ?1 GROUP BY question`,
  );
  const bandRows = await rows("SELECT band, SUM(players) AS players FROM score_bands WHERE date >= ?1 GROUP BY band");
  const byQ = new Map(qs.map((r) => [r.question, r]));
  const all = byQ.get(0);
  const bands = Array(BANDS).fill(0);
  for (const r of bandRows) if (r.band >= 0 && r.band < BANDS) bands[r.band] = r.players;
  const body = {
    since,
    days: all?.days ?? 0,
    finished: all?.answers ?? 0,
    average: all?.answers ? Math.round(all.points / all.answers) : null,
    perfect: all?.perfect ?? 0,
    questions: [1, 2, 3, 4, 5].map((q) => {
      const r = byQ.get(q);
      return r?.answers
        ? { answers: r.answers, average: Math.round(r.points / r.answers), perfectShare: Math.round((100 * r.perfect) / r.answers) }
        : { answers: 0, average: null, perfectShare: null };
    }),
    bands,
  };
  const res = new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return res;
}

/** A score note, when it is short and well formed: q 1-5 with a whole score 0-100, or q 0 with the day's total 0-1000,
 * and the game date it was played for, which must be today's or yesterday's (a game begun before 4 a.m.). */
async function scoreNote(request, now = new Date()) {
  try {
    const text = await request.text();
    if (text.length > 200) return null;
    const { q, score, date } = JSON.parse(text);
    if (!Number.isInteger(q) || q < 0 || q > 5 || !Number.isInteger(score)) return null;
    const most = q === 0 ? 1000 : 100;
    if (score < 0 || score > most) return null;
    const today = gameDate(now);
    const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
    if (date !== today && date !== yesterday) return null;
    return { q, score, date, perfect: score === most ? 1 : 0 };
  } catch {
    return null;
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

/** GET /api/day/N: day N's held copy, once its 4 a.m. has come and only when its hash is the one the list names. */
async function serveHeld(request, env, n) {
  const list = await heldList(request, env);
  if (!list || n > dayNumber(list.firstDate)) return answer(404);
  const body = await storedDay(env, n, list.days[n]);
  if (!body) return answer(404);
  return new Response(body, { headers: { "content-type": heldType(list), "cache-control": "no-store" } });
}

/** A held copy is sealed while the site is locked and plain JSON once it is open (days/held.json says which). */
const heldType = (list) => (list?.open === true ? "application/json; charset=utf-8" : "application/octet-stream");

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

/**
 * POST /api/held-day/N with { key }: day N's held copy, still sealed, for gwctrivia.com/analytics only, whatever its date
 * (Chris, 17 November 2026, of the page's On This Day card: "We have 365 days correct? Why not be able to scroll through
 * all of them"). The counts key is the page's own (sealed under its password), so no player can ask; the copy stays
 * sealed under the site's password, which the page already holds.
 */
async function serveHeldToAnalytics(request, env, n) {
  const list = await heldList(request, env);
  const body = list ? await storedDay(env, n, list.days[n]) : null;
  if (!body) return answer(404);
  return new Response(body, { headers: { "content-type": heldType(list), "cache-control": "no-store" } });
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

/** The note, when it carries the counts key; null otherwise. Compares the key's hash, every character, whatever matches first. */
async function countsNote(request) {
  try {
    const text = await request.text();
    if (text.length > 200) return null;
    const note = JSON.parse(text);
    const key = note?.key;
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    let differ = 0;
    for (let i = 0; i < hex.length; i++) differ |= hex.charCodeAt(i) ^ COUNTS_KEY_SHA256.charCodeAt(i);
    return differ === 0 ? note : null;
  } catch {
    return null;
  }
}

/** True when the note carries the counts key. */
async function holdsCountsKey(request) {
  return (await countsNote(request)) !== null;
}

// the tables whose rows are dated by game date (`date`), and so the ones the trial's counts sit in
const COUNT_TABLES = ["daily", "question_scores", "score_bands"];

/** POST /api/clear-counts: the rows dated before `before` in each counts table, removed only when `clear` is true. */
async function clearCounts(env, note) {
  const before = note.before;
  if (typeof before !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(before) || Number.isNaN(Date.parse(before))) {
    return answer(400);
  }
  const found = {};
  const removed = {};
  for (const table of COUNT_TABLES) {
    try {
      found[table] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE date < ?1`).bind(before).first()).n;
      if (note.clear === true) {
        removed[table] = (await env.DB.prepare(`DELETE FROM ${table} WHERE date < ?1`).bind(before).run()).meta?.changes ?? 0;
      }
    } catch (e) {
      if (!/no such table/i.test(String(e))) throw e;
      found[table] = 0;
    }
  }
  const left = {};
  for (const table of COUNT_TABLES) {
    try {
      left[table] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
    } catch (e) {
      if (!/no such table/i.test(String(e))) throw e;
      left[table] = 0;
    }
  }
  return new Response(JSON.stringify({ before, cleared: note.clear === true, found, removed, left }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Every row of `daily`, oldest first, and the game's date today. No table yet: no rows. */
async function readCounts(env) {
  let rows = [];
  try {
    rows = (await env.DB.prepare("SELECT * FROM daily ORDER BY date").all()).results ?? [];
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
  }
  let scores = [];
  try {
    scores = (await env.DB.prepare("SELECT * FROM question_scores ORDER BY date, question").all()).results ?? [];
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
  }
  return new Response(JSON.stringify({ today: gameDate(), rows, scores }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // gwctrivia.com/analytics (src/Analytics.tsx) with a slash after it would read its scripts from /analytics/assets/,
    // which do not exist; the page's one address is /analytics
    if (url.pathname.startsWith("/analytics/")) return Response.redirect(`${url.origin}/analytics`, 301);
    const heldDayApi = url.pathname.match(/^\/api\/held-day\/(\d{1,4})$/);
    if (heldDayApi) {
      if (request.method !== "POST") return answer(405);
      const origin = request.headers.get("origin");
      if (origin && origin !== "https://gwctrivia.com") return answer(403);
      if (!env.DB) return answer(503);
      if (!(await holdsCountsKey(request))) return answer(403);
      try {
        return await serveHeldToAnalytics(request, env, Number(heldDayApi[1]));
      } catch {
        return answer(500);
      }
    }
    const dayApi = url.pathname.match(/^\/api\/day\/(\d{1,4})$/);
    if (dayApi || url.pathname === "/api/held-status") {
      const origin = request.headers.get("origin");
      if (origin && origin !== "https://gwctrivia.com") return answer(403);
      if (!env.DB) return answer(503);
      if (!dayApi) return request.method === "GET" ? heldStatus(request, env) : answer(405);
      if (request.method === "GET") {
        try {
          return await serveHeld(request, env, Number(dayApi[1]));
        } catch {
          return answer(500);
        }
      }
      return request.method === "POST" ? holdDay(request, env, Number(dayApi[1])) : answer(405);
    }
    if (url.pathname === "/api/today" || url.pathname === "/api/alltime") {
      if (request.method !== "GET") return answer(405);
      if (!env.DB) return answer(503);
      try {
        return await (url.pathname === "/api/today" ? todayStats : allTimeStats)(request, env, url);
      } catch {
        return answer(500);
      }
    }
    if (url.pathname === "/api/clear-counts") {
      if (request.method !== "POST") return answer(405);
      const origin = request.headers.get("origin");
      if (origin && origin !== "https://gwctrivia.com") return answer(403);
      if (!env.DB) return answer(503);
      const note = await countsNote(request);
      if (!note) return answer(403);
      try {
        return await clearCounts(env, note);
      } catch {
        return answer(500);
      }
    }
    const counts = url.pathname === "/api/counts";
    if (!counts && !["/api/played", "/api/pressed", "/api/scored"].includes(url.pathname)) return env.ASSETS.fetch(request);
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

    if (url.pathname === "/api/scored") {
      const n = await scoreNote(request);
      if (!n) return answer(400);
      const add = env.DB.prepare(
        `INSERT INTO question_scores (date, question, answers, points, perfect) VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(date, question) DO UPDATE SET answers = answers + 1, points = points + ?3, perfect = perfect + ?4`,
      ).bind(n.date, n.q, n.score, n.perfect);
      try {
        try {
          await add.run();
        } catch (e) {
          if (!/no such table/i.test(String(e))) throw e;
          await env.DB.prepare(SCORES_SCHEMA).run();
          await add.run();
        }
      } catch {
        return answer(500);
      }
      // the day's total also counts in its band of 50 points, for the curve of everyone's totals
      if (n.q === 0) {
        const band = env.DB.prepare(
          `INSERT INTO score_bands (date, band, players) VALUES (?1, ?2, 1)
           ON CONFLICT(date, band) DO UPDATE SET players = players + 1`,
        ).bind(n.date, Math.min(BANDS - 1, Math.floor(n.score / BAND)));
        try {
          try {
            await band.run();
          } catch (e) {
            if (!/no such table/i.test(String(e))) throw e;
            await env.DB.prepare(BANDS_SCHEMA).run();
            await band.run();
          }
        } catch {
          /* the question totals are in; only the curve misses this one */
        }
      }
      return answer(204);
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
