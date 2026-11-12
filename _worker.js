/**
 * gwctrivia.com's daily count (Chris, 10 November 2026: "i want to know daily players and returning players").
 *
 * Cloudflare Pages runs this file for /api/* and /analytics/* only (_routes.json beside it); every other file is served
 * as it is.
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
const BUTTON = { share: "shared", copy: "copied", otd: "on_this_day" };

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
  on_this_day INTEGER NOT NULL DEFAULT 0
)`;
// columns added after the table was first made, added to a table that lacks them
const ADDED = ["shared", "copied", "on_this_day"];

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
