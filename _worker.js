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
 * Read the totals in Cloudflare: Storage & databases → D1 SQL database → gwctrivia-counts → the `daily` table.
 */

// what the note says → the column it adds one to (a fixed list: nothing a player sends ever becomes SQL)
const BACK = {
  new: "new_players",
  yesterday: "back_from_yesterday",
  "this-week": "back_within_a_week",
  longer: "back_after_longer",
};

// made the first time a note arrives, if it is not there yet
const SCHEMA = `CREATE TABLE IF NOT EXISTS daily (
  date TEXT PRIMARY KEY,
  players INTEGER NOT NULL DEFAULT 0,
  returning_players INTEGER NOT NULL DEFAULT 0,
  new_players INTEGER NOT NULL DEFAULT 0,
  back_from_yesterday INTEGER NOT NULL DEFAULT 0,
  back_within_a_week INTEGER NOT NULL DEFAULT 0,
  back_after_longer INTEGER NOT NULL DEFAULT 0
)`;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // gwctrivia.com/analytics (src/Analytics.tsx) with a slash after it would read its scripts from /analytics/assets/,
    // which do not exist; the page's one address is /analytics
    if (url.pathname.startsWith("/analytics/")) return Response.redirect(`${url.origin}/analytics`, 301);
    if (url.pathname !== "/api/played") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return answer(405);
    // a browser on any other site may not add to the count
    const origin = request.headers.get("origin");
    if (origin && origin !== "https://gwctrivia.com") return answer(403);

    let back;
    try {
      const text = await request.text();
      if (text.length > 200) return answer(413);
      back = JSON.parse(text).back;
    } catch {
      return answer(400);
    }
    if (typeof back !== "string" || !Object.hasOwn(BACK, back)) return answer(400);
    if (!env.DB) return answer(503);

    const column = BACK[back];
    const returning = back === "new" ? 0 : 1;
    const add = env.DB.prepare(
      `INSERT INTO daily (date, players, returning_players, ${column}) VALUES (?1, 1, ?2, 1)
       ON CONFLICT(date) DO UPDATE SET players = players + 1,
         returning_players = returning_players + ?2, ${column} = ${column} + 1`,
    ).bind(gameDate(), returning);
    try {
      await add.run();
    } catch (e) {
      if (!/no such table/i.test(String(e))) return answer(500);
      await env.DB.prepare(SCHEMA).run();
      await add.run();
    }
    return answer(204);
  },
};
