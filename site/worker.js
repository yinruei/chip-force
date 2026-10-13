// ============================================================
// 籌碼力度選股 — 會員網站（Cloudflare Worker）
//
// 流程：
//   1. 會員用 email + 密碼 + 「本月驗證碼」註冊 → 帳號進入「待核准」
//   2. 管理者在 /admin 核准（確認他是 Skool 付費會員）→ 可以登入看頁面
//   3. 每月第一次進站要輸入新的驗證碼；驗證碼只貼在 Skool 付費課程裡，退訂的人拿不到
//   4. 每個帳號最多同時 2 台裝置登入，第 3 台登入會把最舊的登出
//
// KV（binding: SITE_KV）：
//   user:<email>   會員資料 JSON
//   sess:<id>      會員登入（30 天）
//   admin:<id>     管理者登入（12 小時）
//   rl:<key>       失敗次數（防暴力破解）
//   dashboard      頁面 HTML（由 GitHub Actions 每天上傳）
//
// Secrets：SITE_SECRET（產生每月驗證碼）、ADMIN_PASSWORD（管理頁密碼）
// 選填：RESEND_API_KEY + ADMIN_EMAIL + MAIL_FROM（有人註冊時寄信通知管理者）
// ============================================================

const SESSION_DAYS = 30;
const MAX_DEVICES = 2;
const PBKDF2_ITER = 100000;
const enc = new TextEncoder();

// ---------- 小工具 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomId = (n = 24) => hex(crypto.getRandomValues(new Uint8Array(n)));
const normEmail = (s) => String(s || "").trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;

// 台北時間的年月，例如 "202610"
function taipeiMonth(offsetMonths = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + offsetMonths;
  const t = new Date(Date.UTC(y, m, 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}
const monthLabel = (ym) => `${ym.slice(0, 4)} 年 ${+ym.slice(4)} 月`;

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// 每月驗證碼：由 SITE_SECRET 與年月算出，不必儲存；6 碼，排除容易看錯的字（0/O、1/I/L）
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
async function monthCode(env, ym) {
  const b = await hmac(env.SITE_SECRET, `month-code:${ym}`);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}
const normCode = (s) => String(s || "").trim().toUpperCase().replace(/[\s-]/g, "");

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: hex(salt), hash: hex(bits) };
}
// 固定時間比較，避免從回應時間猜出內容
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function cookies(req) {
  const out = {};
  (req.headers.get("Cookie") || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const setCookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });

// 防暴力破解：同一個 key 15 分鐘內最多失敗 limit 次
async function tooMany(env, key, limit = 10) {
  const n = parseInt((await env.SITE_KV.get(`rl:${key}`)) || "0", 10);
  return n >= limit;
}
async function addFail(env, key) {
  const n = parseInt((await env.SITE_KV.get(`rl:${key}`)) || "0", 10);
  await env.SITE_KV.put(`rl:${key}`, String(n + 1), { expirationTtl: 900 });
}

const getUser = async (env, email) => {
  const raw = await env.SITE_KV.get(`user:${email}`);
  return raw ? JSON.parse(raw) : null;
};
const putUser = (env, u) => env.SITE_KV.put(`user:${u.email}`, JSON.stringify(u));

async function currentUser(env, req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const raw = await env.SITE_KV.get(`sess:${sid}`);
  if (!raw) return null;
  const { email } = JSON.parse(raw);
  const u = await getUser(env, email);
  if (!u || !(u.sessions || []).includes(sid)) return null;
  return { user: u, sid };
}

async function isAdmin(env, req) {
  const id = cookies(req).adm;
  return !!(id && (await env.SITE_KV.get(`admin:${id}`)));
}

// ---------- 版面 ----------
const STYLE = `
:root{--bg:#f3f4f5;--surface:#fcfcfb;--ink:#0f1112;--ink-2:#4a4f53;--ink-3:#7a8085;--line:#dfe2e4;--accent:#2a78d6;--bad:#b42318;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#101213;--surface:#1a1a19;--ink:#f2f3f3;--ink-2:#bcc1c4;--ink-3:#8b9196;--line:#2c2f31;--accent:#3987e5;--bad:#f97066;--ok:#4ac26b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC",system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;padding:32px 16px}
.box{max-width:420px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}
.wide{max-width:960px}
h1{font-size:22px;margin:0 0 4px}p{margin:8px 0;color:var(--ink-2)}
label{display:block;font-size:13px;color:var(--ink-3);margin:14px 0 4px}
input{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:10px 14px;background:var(--ink);color:var(--bg);font-weight:500}
button.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--line);padding:6px 10px;font-size:13px}
.full{width:100%;margin-top:18px}
.msg{padding:10px 12px;border-radius:8px;margin:12px 0;font-size:14px;border:1px solid var(--line)}
.msg.bad{color:var(--bad);border-color:currentColor}.msg.ok{color:var(--ok);border-color:currentColor}
a{color:var(--accent)}.small{font-size:13px;color:var(--ink-3)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;color:var(--ink-3);font-weight:500}
.code{font:600 28px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.15em}
.tag{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
.row{display:flex;gap:6px;flex-wrap:wrap}form.inline{display:inline}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:14px}
`;
function page(title, body, { wide = false, status = 200 } = {}) {
  return new Response(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}｜籌碼力度選股</title><style>${STYLE}</style></head><body><div class="box${wide ? " wide" : ""}">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } }
  );
}
const msg = (text, kind = "bad") => (text ? `<div class="msg ${kind}">${esc(text)}</div>` : "");
const DISCLAIMER = `<p class="small">本站內容依證交所、櫃買中心公開資料統計，僅供研究參考，非投資建議。</p>`;

function loginPage(err = "", note = "", email = "") {
  return page("登入", `<h1>籌碼力度選股</h1><p>Skool 付費會員專屬。</p>${msg(err)}${msg(note, "ok")}
  <form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
    <label for="password">密碼</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button class="full" type="submit">登入</button>
  </form>
  <p class="small" style="margin-top:16px">還沒有帳號？<a href="/register">用本月驗證碼註冊</a></p>${DISCLAIMER}`);
}

function registerPage(err = "", email = "") {
  return page("註冊", `<h1>註冊會員帳號</h1><p>本月驗證碼在 Skool 付費課程裡。註冊後需等管理者核准。</p>${msg(err)}
  <form method="post" action="/register">
    <label for="email">Email（請用你 Skool 帳號的 email）</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
    <label for="password">密碼（至少 8 碼）</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <label for="code">本月驗證碼</label><input id="code" name="code" autocomplete="off" required>
    <button class="full" type="submit">送出註冊</button>
  </form>
  <p class="small" style="margin-top:16px">已經有帳號？<a href="/login">登入</a></p>${DISCLAIMER}`);
}

function verifyPage(email, err = "") {
  return page("每月驗證", `<h1>${monthLabel(taipeiMonth())}驗證</h1><p>每個月第一次進站，請輸入 Skool 付費課程裡的本月驗證碼。</p>${msg(err)}
  <form method="post" action="/verify">
    <label for="code">本月驗證碼</label><input id="code" name="code" autocomplete="off" required autofocus>
    <button class="full" type="submit">確認</button>
  </form>
  <p class="small" style="margin-top:16px">${esc(email)}・<a href="/logout">登出</a></p>`);
}

const statusPage = (title, text, email) =>
  page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p class="small" style="margin-top:16px">${esc(email)}・<a href="/logout">登出</a></p>`);

// ---------- 會員端 ----------
async function handleRegister(req, env, ip) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), password = String(f.get("password") || ""), code = normCode(f.get("code"));
  if (await tooMany(env, `reg:${ip}`)) return registerPage("嘗試次數太多，請 15 分鐘後再試。", email);
  if (!validEmail(email)) return registerPage("Email 格式不正確。", email);
  if (password.length < 8) return registerPage("密碼至少 8 碼。", email);
  if (!safeEqual(code, await monthCode(env, taipeiMonth()))) {
    await addFail(env, `reg:${ip}`);
    return registerPage("驗證碼不正確，請確認是本月的驗證碼。", email);
  }
  if (await getUser(env, email)) return registerPage("這個 email 已經註冊過，請直接登入。", email);
  const { salt, hash } = await hashPassword(password);
  await putUser(env, { email, salt, hash, status: "pending", created: new Date().toISOString(), verified_month: taipeiMonth(), sessions: [] });
  await notifyAdmin(env, email);
  return page("已送出", `<h1>註冊已送出</h1><p>管理者確認你是 Skool 付費會員後就會開通，通常一天內。開通後用剛才的 email 和密碼登入即可。</p><p><a href="/login">回登入頁</a></p>`);
}

async function notifyAdmin(env, email) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM || "籌碼力度選股 <onboarding@resend.dev>",
        to: [env.ADMIN_EMAIL],
        subject: `新會員待核准：${email}`,
        text: `${email} 剛註冊籌碼力度選股，請到 Skool 確認是付費會員後，在管理頁核准：/admin`,
      }),
    });
  } catch (e) { /* 通知失敗不影響註冊 */ }
}

async function handleLogin(req, env, ip) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), password = String(f.get("password") || "");
  if ((await tooMany(env, `login:${ip}`, 20)) || (await tooMany(env, `login:${email}`))) return loginPage("嘗試次數太多，請 15 分鐘後再試。", "", email);
  const u = await getUser(env, email);
  const { hash } = await hashPassword(password, u ? u.salt : "00".repeat(16));
  if (!u || !safeEqual(hash, u.hash)) {
    await addFail(env, `login:${ip}`); await addFail(env, `login:${email}`);
    return loginPage("Email 或密碼不正確。", "", email);
  }
  if (u.status === "disabled") return loginPage("這個帳號已停用，如有疑問請在 Skool 聯絡管理者。", "", email);
  // 建立登入；超過裝置上限就把最舊的登出
  const sid = randomId();
  await env.SITE_KV.put(`sess:${sid}`, JSON.stringify({ email, created: Date.now() }), { expirationTtl: SESSION_DAYS * 86400 });
  u.sessions = [...(u.sessions || []), sid];
  while (u.sessions.length > MAX_DEVICES) await env.SITE_KV.delete(`sess:${u.sessions.shift()}`);
  await putUser(env, u);
  return redirect("/", { "Set-Cookie": setCookie("sid", sid, SESSION_DAYS * 86400) });
}

async function handleLogout(req, env) {
  const cu = await currentUser(env, req);
  if (cu) {
    await env.SITE_KV.delete(`sess:${cu.sid}`);
    cu.user.sessions = (cu.user.sessions || []).filter((s) => s !== cu.sid);
    await putUser(env, cu.user);
  }
  return redirect("/login?m=out", { "Set-Cookie": setCookie("sid", "", 0) });
}

async function handleVerify(req, env, ip, cu) {
  const code = normCode((await req.formData()).get("code"));
  if (await tooMany(env, `verify:${cu.user.email}`)) return verifyPage(cu.user.email, "嘗試次數太多，請 15 分鐘後再試。");
  if (!safeEqual(code, await monthCode(env, taipeiMonth()))) {
    await addFail(env, `verify:${cu.user.email}`);
    return verifyPage(cu.user.email, "驗證碼不正確，請確認是本月的驗證碼。");
  }
  cu.user.verified_month = taipeiMonth();
  await putUser(env, cu.user);
  return redirect("/");
}

async function serveDashboard(env, cu) {
  const html = await env.SITE_KV.get("dashboard");
  if (!html) return statusPage("頁面準備中", "今天的資料還沒上傳，請稍後再來。", cu.user.email);
  const bar = `<div style="font:13px system-ui,sans-serif;display:flex;justify-content:flex-end;gap:12px;padding:8px 16px;color:#7a8085">${esc(cu.user.email)}<a href="/logout" style="color:inherit">登出</a></div>`;
  // dashboard.html 是不含 <html>/<body> 的頁面片段（原本給 Artifact 用），這裡補上完整骨架
  const doc = /<!doctype/i.test(html)
    ? html.replace(/<body([^>]*)>/i, (m) => m + bar)
    : `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${bar}${html}</body></html>`;
  return new Response(doc, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
  });
}

// ---------- 管理端 ----------
function adminLoginPage(err = "") {
  return page("管理登入", `<h1>管理頁</h1>${msg(err)}<form method="post" action="/admin/login">
  <label for="pw">管理密碼</label><input id="pw" name="password" type="password" required autofocus>
  <button class="full" type="submit">登入</button></form>`);
}

async function adminHome(env, note = "") {
  const list = [];
  let cursor;
  do {
    const r = await env.SITE_KV.list({ prefix: "user:", cursor });
    for (const k of r.keys) {
      const u = await getUser(env, k.name.slice(5));
      if (u) list.push(u);
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const order = { pending: 0, active: 1, disabled: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || a.created.localeCompare(b.created));
  const label = { pending: "待核准", active: "已開通", disabled: "已停用" };
  const btn = (email, action, text) => `<form class="inline" method="post" action="/admin/action"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="action" value="${action}"><button class="ghost" type="submit">${text}</button></form>`;
  const cur = taipeiMonth(), next = taipeiMonth(1);
  const rows = list.map((u) => `<tr><td>${esc(u.email)}</td><td><span class="tag">${label[u.status]}</span></td><td>${esc(u.created.slice(0, 10))}</td><td>${u.verified_month === cur ? "本月已驗證" : "本月未驗證"}</td><td>${(u.sessions || []).length}</td><td class="row">${
    u.status === "pending" ? btn(u.email, "approve", "核准") + btn(u.email, "delete", "刪除")
      : u.status === "active" ? btn(u.email, "disable", "停用") + btn(u.email, "logout", "全部登出")
      : btn(u.email, "approve", "重新開通") + btn(u.email, "delete", "刪除")
  }</td></tr>`).join("") || `<tr><td colspan="6" class="small">還沒有人註冊。</td></tr>`;
  const counts = (s) => list.filter((u) => u.status === s).length;
  return page("管理頁", `<div style="display:flex;justify-content:space-between;align-items:center"><h1>管理頁</h1><a href="/admin/logout" class="small">登出管理頁</a></div>${msg(note, "ok")}
  <div class="cards">
    <div class="card"><div class="small">${monthLabel(cur)}驗證碼（貼到 Skool 課程）</div><div class="code">${await monthCode(env, cur)}</div></div>
    <div class="card"><div class="small">${monthLabel(next)}驗證碼（下個月 1 號換上）</div><div class="code">${await monthCode(env, next)}</div></div>
    <div class="card"><div class="small">會員</div><div style="font-size:20px">待核准 ${counts("pending")}・已開通 ${counts("active")}・已停用 ${counts("disabled")}</div></div>
  </div>
  <p class="small">核准前請到 Skool 確認對方是付費會員（用 email 對照）。核准或停用後，最多約 1 分鐘生效。</p>
  <div style="overflow-x:auto"><table><thead><tr><th>Email</th><th>狀態</th><th>註冊日</th><th>每月驗證</th><th>登入裝置</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`, { wide: true });
}

async function adminAction(req, env) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), action = String(f.get("action") || "");
  const u = await getUser(env, email);
  if (!u) return adminHome(env, "找不到這個帳號。");
  const dropSessions = async () => { for (const s of u.sessions || []) await env.SITE_KV.delete(`sess:${s}`); u.sessions = []; };
  if (action === "approve") { u.status = "active"; await putUser(env, u); return adminHome(env, `已開通 ${email}`); }
  if (action === "disable") { u.status = "disabled"; await dropSessions(); await putUser(env, u); return adminHome(env, `已停用 ${email}`); }
  if (action === "logout") { await dropSessions(); await putUser(env, u); return adminHome(env, `已將 ${email} 全部登出`); }
  if (action === "delete") { await dropSessions(); await env.SITE_KV.delete(`user:${email}`); return adminHome(env, `已刪除 ${email}`); }
  return adminHome(env, "不明的操作。");
}

// ---------- 路由 ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    if (!env.SITE_SECRET || !env.ADMIN_PASSWORD) return page("尚未設定", "<h1>尚未設定</h1><p>請先設定 SITE_SECRET 與 ADMIN_PASSWORD。</p>", { status: 500 });

    // 只接受從本站送出的表單（防 CSRF）
    if (req.method === "POST") {
      const origin = req.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
    }

    if (path.startsWith("/admin")) {
      if (path === "/admin/login" && req.method === "POST") {
        if (await tooMany(env, `admin:${ip}`, 5)) return adminLoginPage("嘗試次數太多，請 15 分鐘後再試。");
        const pw = String((await req.formData()).get("password") || "");
        if (!safeEqual(pw, env.ADMIN_PASSWORD)) { await addFail(env, `admin:${ip}`); return adminLoginPage("密碼不正確。"); }
        const id = randomId();
        await env.SITE_KV.put(`admin:${id}`, "1", { expirationTtl: 12 * 3600 });
        return redirect("/admin", { "Set-Cookie": setCookie("adm", id, 12 * 3600) });
      }
      if (path === "/admin/logout") {
        const id = cookies(req).adm;
        if (id) await env.SITE_KV.delete(`admin:${id}`);
        return redirect("/admin", { "Set-Cookie": setCookie("adm", "", 0) });
      }
      if (!(await isAdmin(env, req))) return adminLoginPage();
      if (path === "/admin/action" && req.method === "POST") return adminAction(req, env);
      return adminHome(env);
    }

    if (path === "/register") return req.method === "POST" ? handleRegister(req, env, ip) : registerPage();
    if (path === "/login") {
      if (req.method === "POST") return handleLogin(req, env, ip);
      return loginPage("", url.searchParams.get("m") === "out" ? "已登出。" : "");
    }
    if (path === "/logout") return handleLogout(req, env);

    const cu = await currentUser(env, req);
    if (!cu) return redirect("/login");
    if (cu.user.status === "pending") return statusPage("等待核准中", "管理者確認你是 Skool 付費會員後就會開通，通常一天內。", cu.user.email);
    if (cu.user.status !== "active") return statusPage("帳號已停用", "如有疑問請在 Skool 聯絡管理者。", cu.user.email);
    if (cu.user.verified_month !== taipeiMonth()) {
      if (path === "/verify" && req.method === "POST") return handleVerify(req, env, ip, cu);
      return verifyPage(cu.user.email);
    }
    if (path === "/" || path === "/verify") return serveDashboard(env, cu);
    return new Response("Not found", { status: 404 });
  },
};
