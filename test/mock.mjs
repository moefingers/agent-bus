// Patches global fetch with a tiny file-backed GitHub Issues API (issues,
// comments, reactions) so agent-bus-web.mjs is exercised end-to-end with zero
// network. Loaded via `node --import`; state lives in the JSON file named by
// $MOCK_DB. Test-only — the real bus never loads this.
import { readFileSync, writeFileSync } from "node:fs";

const DB = process.env.MOCK_DB;
const load = () => JSON.parse(readFileSync(DB, "utf8"));
const save = (d) => writeFileSync(DB, JSON.stringify(d, null, 1));
const ts = (id) => new Date(Date.UTC(2026, 0, 1, 0, 0, id - 100)).toISOString(); // monotonic with id

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
  const db = load();
  const respond = (status, json, headers = {}) => ({
    status,
    text: async () => (json === null ? "" : JSON.stringify(json)),
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  });

  const mc = u.pathname.match(/\/issues\/(\d+)\/comments$/);
  if (method === "GET" && mc) {
    const since = u.searchParams.get("since");
    const items = db.comments.filter((c) => !since || c.created_at >= since);
    const etag = 'W/"' + items.map((c) => `${c.id}.${c.reactions.eyes}`).join(",") + '"';
    const inm = opts.headers && (opts.headers["If-None-Match"] || opts.headers["if-none-match"]);
    if (inm && inm === etag) return respond(304, null, { etag });
    return respond(200, items, { etag });
  }
  if (method === "POST" && mc) {
    const id = (db.comments.at(-1)?.id ?? 100) + 1;
    const c = { id, created_at: ts(id), body: JSON.parse(opts.body).body, reactions: { eyes: 0 } };
    db.comments.push(c); save(db);
    return respond(201, c);
  }
  const mr = u.pathname.match(/\/issues\/comments\/(\d+)\/reactions$/);
  if (method === "POST" && mr) {
    const c = db.comments.find((x) => x.id === Number(mr[1]));
    if (!c) return respond(404, { message: "mock: no such comment" });
    c.reactions.eyes++; save(db);
    return respond(201, { content: JSON.parse(opts.body).content });
  }
  if (method === "GET" && /\/repos\/[^/]+\/[^/]+\/issues$/.test(u.pathname)) {
    return respond(200, db.issues);
  }
  if (method === "POST" && /\/repos\/[^/]+\/[^/]+\/issues$/.test(u.pathname)) {
    const num = (db.issues.at(-1)?.number ?? 0) + 1;
    db.issues.push({ number: num, title: JSON.parse(opts.body).title }); save(db);
    return respond(201, { number: num });
  }
  return respond(404, { message: `mock: no route ${method} ${u.pathname}` });
};
