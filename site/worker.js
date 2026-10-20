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
//   rst:<token>    重設密碼連結（自助 1 小時、管理者產生 24 小時）
//   wl:<email>     追蹤的股票 [{c, n, m}]
//   push:<email>   推播訂閱（每台裝置一筆，瀏覽器產生）
//   vapid          推播金鑰（第一次有人開通知時自動產生；notify.py 用它簽名）
//   notified       上次送出追蹤通知的交易日（notify.py 寫入，避免重複通知）
//   demo、demo_series  展示版頁面與明細（延遲約一個月的資料）
//
// Secrets：SITE_SECRET（產生每月驗證碼）、ADMIN_PASSWORD（管理頁密碼）
// 選填：RESEND_API_KEY + ADMIN_EMAIL（有人註冊時寄信通知管理者）
//       再加上 MAIL_FROM（Resend 已驗證的網域寄件人）才會開放會員自己用 email 重設密碼
// 變數：SKOOL_URL（放本月驗證碼的 Skool 課程網址，在 wrangler.toml 的 [vars]）
// 選用 GH_TOKEN（只能觸發 GH_REPO 工作流程的 GitHub token）：有設定時，wrangler.toml 的排程會
//   準時觸發每日選股（GitHub 自己的排程常延遲好幾小時）
// ============================================================

import { ICON_512, ICON_192, ICON_180 } from "./icons.js";
import { LEGAL_LINKS, TERMS_VERSION, termsBody, privacyBody, refundBody } from "./legal.js";

const SESSION_DAYS = 30;
const MAX_DEVICES = 2;
// 密碼雜湊次數。免費方案每個請求只有約 10ms CPU，10 萬次要 40ms 以上，登入會被拖慢甚至卡住，
// 所以改成 1 萬次（搭配登入次數限制）。舊帳號存的是 10 萬次，下次登入成功時自動換成新的次數。
const PBKDF2_ITER = 10000;
const LEGACY_ITER = 100000;
const enc = new TextEncoder();
const RESET_HOURS_SELF = 1;   // 會員自己用 email 重設：連結 1 小時內有效
const RESET_HOURS_ADMIN = 24; // 管理者產生給會員的連結：24 小時內有效
const DEFAULT_SKOOL_URL = "https://www.skool.com/fosi-trading-1190/classroom/f2d532b7?md=38579a96eb5a4c3faeaeb2d3c9c4b917";
const skoolUrl = (env) => env.SKOOL_URL || DEFAULT_SKOOL_URL;
// 沒有驗證過的寄件網域時，Resend 只能寄給帳號本人，所以要有 MAIL_FROM 才開放會員自助重設
const selfResetOn = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

// ---------- 加到主畫面（像 APP 一樣全螢幕開啟） ----------
const APP_NAME = "籌碼力度選股";
const THEME = "#0b1d44";
const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="${THEME}"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${APP_NAME}"><meta name="apple-mobile-web-app-status-bar-style" content="default">`;
const MANIFEST = JSON.stringify({
  name: APP_NAME, short_name: APP_NAME, start_url: "/", scope: "/", display: "standalone",
  background_color: "#f3f4f5", theme_color: THEME, lang: "zh-Hant",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
const ICONS = { "/icon-512.png": ICON_512, "/icon-192.png": ICON_192, "/apple-touch-icon.png": ICON_180 };
// 推播用的 service worker：只負責顯示通知、點通知打開網站，不快取任何頁面
const SW_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "${APP_NAME}", { body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || "chip-force", data: { url: d.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});`;
function appAsset(path) {
  if (path === "/sw.js") return new Response(SW_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" } });
  const b64 = ICONS[path];
  if (!b64) return null;
  return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}

// ---------- 小工具 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomId = (n = 24) => hex(crypto.getRandomValues(new Uint8Array(n)));
const normEmail = (s) => String(s || "").trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
// Skool 個人帳號（個人檔案網址 skool.com/@ 後面那段）。接受「@abc-123」「abc-123」或整個網址
const normHandle = (s) => String(s || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?skool\.com\//, "").replace(/^@/, "").replace(/[/?#].*$/, "");
const validHandle = (h) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(h);
const skoolProfile = (h) => `https://www.skool.com/@${h}`;

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

async function hashPassword(password, saltHex, iter = PBKDF2_ITER) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return { salt: hex(salt), hash: hex(bits), iter };
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

// 會員資料分成四個 key，各自只由該改它的動作寫入。KV 各地同步會延遲約 1 分鐘，
// 以前整筆資料放在一起時，會員登入/登出會把舊的「待核准」寫回去，蓋掉管理者剛按的核准。
//   user:<email>  帳號密碼（註冊、重設密碼、登入時升級雜湊）
//   st:<email>    狀態 pending / active / disabled（只有註冊和管理者會寫）
//   vm:<email>    已完成每月驗證的年月（會員輸入驗證碼）
//   ss:<email>    登入中的裝置 session 清單（登入、登出、管理者）
const ACCOUNT_FIELDS = ["email", "salt", "hash", "iter", "created", "skool", "agreed"];   // agreed：同意的條款版本
async function getUser(env, email) {
  const [raw, st, vm, ss] = await Promise.all(["user", "st", "vm", "ss"].map((p) => env.SITE_KV.get(`${p}:${email}`)));
  if (!raw) return null;
  const a = JSON.parse(raw);
  const u = {
    ...Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, a[k]])),
    status: st ?? a.status ?? "pending",
    verified_month: vm ?? a.verified_month ?? "",
    sessions: ss ? JSON.parse(ss) : a.sessions || [],
  };
  // 舊版資料：第一次讀到時把欄位搬到各自的 key
  if (st === null) await setStatus(env, email, u.status);
  if (vm === null && u.verified_month) await setVerified(env, email, u.verified_month);
  if (ss === null) await setSessions(env, email, u.sessions);
  return u;
}
const putAccount = (env, u) => env.SITE_KV.put(`user:${u.email}`, JSON.stringify(Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, u[k]]))));
const setStatus = (env, email, status) => env.SITE_KV.put(`st:${email}`, status);
const setVerified = (env, email, ym) => env.SITE_KV.put(`vm:${email}`, ym);
const setSessions = (env, email, list) => env.SITE_KV.put(`ss:${email}`, JSON.stringify(list));
async function deleteUser(env, u) {
  await unbindHandle(env, u);
  for (const p of ["user", "st", "vm", "ss", "wl", "push"]) await env.SITE_KV.delete(`${p}:${u.email}`);
}
// sk:<Skool 帳號> → email。一個 Skool 帳號只能綁一個 email，避免冒用別人的付費帳號
async function handleOwner(env, h) { return env.SITE_KV.get(`sk:${h}`); }
async function unbindHandle(env, u) {
  if (u.skool && (await handleOwner(env, u.skool)) === u.email) await env.SITE_KV.delete(`sk:${u.skool}`);
}

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
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#101213;--surface:#1a1a19;--ink:#f2f3f3;--ink-2:#bcc1c4;--ink-3:#8b9196;--line:#2c2f31;--accent:#3987e5;--bad:#f97066;--ok:#4ac26b;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#101213;--surface:#1a1a19;--ink:#f2f3f3;--ink-2:#bcc1c4;--ink-3:#8b9196;--line:#2c2f31;--accent:#3987e5;--bad:#f97066;--ok:#4ac26b;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC",system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;padding:32px 16px}
.box{max-width:420px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}
.wide{max-width:960px}
h1{font-size:22px;margin:0 0 4px}p{margin:8px 0;color:var(--ink-2)}
label{display:block;font-size:13px;color:var(--ink-3);margin:14px 0 4px}
input,textarea{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:10px 14px;background:var(--ink);color:var(--bg);font-weight:500}
button.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--line);padding:6px 10px;font-size:13px}
.full{width:100%;margin-top:18px}
.msg{padding:10px 12px;border-radius:8px;margin:12px 0;font-size:14px;border:1px solid var(--line)}
.msg.bad{color:var(--bad);border-color:currentColor}.msg.ok{color:var(--ok);border-color:currentColor}
a{color:var(--accent)}.small{font-size:13px;color:var(--ink-3)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;color:var(--ink-3);font-weight:500}
.code{font:600 28px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.15em}
.tag{white-space:nowrap;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
h2{font-size:17px;margin:26px 0 6px}ul,ol{padding-left:1.3em;color:var(--ink-2);margin:6px 0}li{margin:3px 0}b{color:var(--ink);font-weight:600}
.row{display:flex;gap:6px;flex-wrap:wrap}form.inline{display:inline}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:14px}
`;
function page(title, body, { wide = false, status = 200 } = {}) {
  return new Response(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${APP_HEAD}<script>try{var t=localStorage.getItem("cf-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}</script><title>${esc(title)}｜籌碼力度選股</title><style>${STYLE}</style></head><body><div class="box${wide ? " wide" : ""}">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } }
  );
}
const msg = (text, kind = "bad") => (text ? `<div class="msg ${kind}">${esc(text)}</div>` : "");
const DISCLAIMER = `<p class="small">本站內容依證交所、櫃買中心公開資料統計，僅供研究參考，非投資建議。</p>`;

const skoolLink = (env, text) => `<a href="${esc(skoolUrl(env))}" target="_blank" rel="noopener">${text}</a>`;

function loginPage(err = "", note = "", email = "") {
  return page("登入", `<h1>籌碼力度選股</h1><p>Skool 付費會員專屬。</p>${msg(err)}${msg(note, "ok")}
  <form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
    <label for="password">本站密碼（註冊時設的，不是 Skool 密碼）</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button class="full" type="submit">登入</button>
  </form>
  <p class="small" style="margin-top:16px"><a href="/forgot">忘記密碼？</a>・還沒有帳號？<a href="/register">用本月驗證碼註冊</a>・<a href="/guide">使用說明</a></p>${DISCLAIMER}<p class="small">${LEGAL_LINKS}</p>`);
}

const HANDLE_HELP = `打開 Skool → 點右上角自己的頭像 → 個人檔案，網址 <b>skool.com/@</b> 後面那段就是（例如 @su-ray-2735），會員列表裡名字下方也看得到。管理者會用它確認你是付費會員。`;
const handleInput = (h = "") => `<input id="skool" name="skool" autocomplete="off" required placeholder="例如 @su-ray-2735" value="${esc(h ? "@" + h : "")}">
    <p class="small" style="margin:4px 0 0">${HANDLE_HELP}</p>`;

function registerPage(env, err = "", email = "", handle = "") {
  return page("註冊", `<h1>註冊會員帳號</h1><p>本月驗證碼在 Skool 付費課程裡：${skoolLink(env, "打開 Skool 課程看驗證碼")}。註冊後需等管理者核准。</p>${msg(err)}
  <form method="post" action="/register">
    <label for="email">Email（請用你 Skool 帳號的 email）</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
    <label for="skool">Skool 帳號</label>${handleInput(handle)}
    <label for="password">設定本站密碼（至少 8 碼）</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <p class="small" style="margin:4px 0 0">這是籌碼力度網站自己的密碼，<b>不是 Skool 密碼</b>。請設一組和 Skool 不同的密碼；之後在 Skool 改密碼，這裡的密碼不會跟著變。</p>
    <label for="password2">再輸入一次本站密碼</label><input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
    <label for="code">本月驗證碼</label><input id="code" name="code" autocomplete="off" required>
    <label style="display:flex;gap:8px;align-items:flex-start;color:var(--ink-2);font-size:14px;margin-top:16px"><input type="checkbox" name="agree" value="1" required style="width:auto;margin-top:4px">
      <span>我已閱讀並同意<a href="/terms" target="_blank">服務條款</a>、<a href="/privacy" target="_blank">隱私權政策</a>與<a href="/refund" target="_blank">退款規則</a>；了解本站內容不是投資建議，且本服務為數位內容，同意立即開始提供、不適用 7 天解除權，付款後不退費。</span></label>
    <button class="full" type="submit">送出註冊</button>
  </form>
  <p class="small" style="margin-top:16px">已經有帳號？<a href="/login">登入</a>・<a href="/guide">使用說明</a></p>${DISCLAIMER}`);
}

function verifyPage(env, email, err = "") {
  return page("每月驗證", `<h1>${monthLabel(taipeiMonth())}驗證</h1><p>每個月第一次進站，請輸入 Skool 付費課程裡的本月驗證碼：${skoolLink(env, "打開 Skool 課程看驗證碼")}。</p>${msg(err)}
  <form method="post" action="/verify">
    <label for="code">本月驗證碼</label><input id="code" name="code" autocomplete="off" required autofocus>
    <button class="full" type="submit">確認</button>
  </form>
  <p class="small" style="margin-top:16px">${esc(email)}・<a href="/guide">使用說明</a>・<a href="/logout">登出</a></p>`);
}

function skoolPage(email, err = "", handle = "") {
  return page("填寫 Skool 帳號", `<h1>填寫你的 Skool 帳號</h1><p>為了確認付費會員身分，請填一次你的 Skool 帳號，之後不用再填。</p>${msg(err)}
  <form method="post" action="/skool">
    <label for="skool">Skool 帳號</label>${handleInput(handle)}
    <button class="full" type="submit">確認</button>
  </form>
  <p class="small" style="margin-top:16px">${esc(email)}・<a href="/logout">登出</a></p>`);
}

// 檢查並綁定 Skool 帳號；回傳錯誤訊息（沒問題則回傳空字串）
async function checkHandle(env, h, email) {
  if (!validHandle(h)) return "Skool 帳號格式不正確，請填個人檔案網址 skool.com/@ 後面那段，例如 @su-ray-2735。";
  const owner = await handleOwner(env, h);
  if (owner && owner !== email) return "這個 Skool 帳號已經綁定其他 email。如果是你本人，請在 Skool 私訊管理者。";
  return "";
}

async function handleSkool(req, env, cu) {
  const h = normHandle((await req.formData()).get("skool"));
  const err = await checkHandle(env, h, cu.user.email);
  if (err) return skoolPage(cu.user.email, err, h);
  await env.SITE_KV.put(`sk:${h}`, cu.user.email);
  cu.user.skool = h;
  await putAccount(env, cu.user);
  return redirect("/");
}

const statusPage = (title, text, email) =>
  page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p class="small" style="margin-top:16px">${esc(email)}・<a href="/logout">登出</a></p>`);

// ---------- 會員端 ----------
async function handleRegister(req, env, ip, origin) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), password = String(f.get("password") || ""), code = normCode(f.get("code"));
  const handle = normHandle(f.get("skool"));
  const again = (err) => registerPage(env, err, email, handle);
  if (await tooMany(env, `reg:${ip}`)) return again("嘗試次數太多，請 15 分鐘後再試。");
  if (!validEmail(email)) return again("Email 格式不正確。");
  if (password.length < 8) return again("密碼至少 8 碼。");
  if (password !== String(f.get("password2") || "")) return again("兩次輸入的密碼不一樣。");
  if (f.get("agree") !== "1") return again("請先勾選同意服務條款、隱私權政策與退款規則。");
  if (!safeEqual(code, await monthCode(env, taipeiMonth()))) {
    await addFail(env, `reg:${ip}`);
    return again("驗證碼不正確，請確認是本月的驗證碼。");
  }
  if (await getUser(env, email)) return again("這個 email 已經註冊過，請直接登入。");
  const herr = await checkHandle(env, handle, email);
  if (herr) return again(herr);
  const { salt, hash, iter } = await hashPassword(password);
  await setStatus(env, email, "pending");
  await setVerified(env, email, taipeiMonth());
  await setSessions(env, email, []);
  await env.SITE_KV.put(`sk:${handle}`, email);
  await putAccount(env, { email, salt, hash, iter, created: new Date().toISOString(), skool: handle, agreed: TERMS_VERSION });
  await notifyAdmin(env, email, handle, origin);
  return page("已送出", `<h1>註冊已送出</h1><p>管理者確認你是 Skool 付費會員後就會開通，通常一天內。開通後用剛才的 email 和你在本站設的密碼登入（不是 Skool 密碼）。</p><p><a href="/login">回登入頁</a></p>`);
}

async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || "籌碼力度選股 <onboarding@resend.dev>", to: [to], subject, text }),
    });
    if (!r.ok) console.log("寄信失敗", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.log("寄信失敗", String(e));
    return false;
  }
}

async function notifyAdmin(env, email, handle, origin) {
  if (!env.ADMIN_EMAIL) return;
  const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
  // 通知失敗不影響註冊
  await sendMail(env, env.ADMIN_EMAIL, `新會員待核准：${email}`,
    `${email} 在 ${when}（台北時間）註冊了籌碼力度選股。\n\nSkool 帳號：@${handle}\n${skoolProfile(handle)}\n\n請先到 Skool 會員列表確認 @${handle} 是付費方案（不是「免費」），再到管理頁核准：\n${origin}/admin\n`);
}

// ---------- 忘記密碼 / 重設密碼 ----------
async function createResetToken(env, email, hours) {
  const t = randomId(24);
  await env.SITE_KV.put(`rst:${t}`, email, { expirationTtl: hours * 3600 });
  return t;
}

function forgotPage(env, note = "", err = "", pre = {}) {
  const body = selfResetOn(env)
    ? `<p>輸入註冊時用的 email，我們會寄一封重設密碼的信給你，連結 ${RESET_HOURS_SELF} 小時內有效。</p>
      <form method="post" action="/forgot"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
      <button class="full" type="submit">寄送重設連結</button></form>
      <p class="small" style="margin-top:16px">沒收到信？先看垃圾郵件匣；還是沒有，請在 Skool 私訊管理者。</p>`
    : `<p>輸入註冊時的 email、你的 Skool 帳號和本月驗證碼，就可以直接設定新密碼。</p>
      <form method="post" action="/forgot">
        <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(pre.email || "")}">
        <label for="skool">Skool 帳號</label><input id="skool" name="skool" autocomplete="off" required placeholder="例如 @su-ray-2735" value="${esc(pre.handle ? "@" + pre.handle : "")}">
        <p class="small" style="margin:4px 0 0">註冊時填的 Skool 個人檔案網址 skool.com/@ 後面那段。</p>
        <label for="code">本月驗證碼</label><input id="code" name="code" autocomplete="off" required>
        <p class="small" style="margin:4px 0 0">在 Skool 付費課程裡：${skoolLink(env, "打開 Skool 課程看驗證碼")}</p>
        <label for="password">新密碼（至少 8 碼，本站專用，不是 Skool 密碼）</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <label for="password2">再輸入一次新密碼</label><input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
        <button class="full" type="submit">重設密碼</button>
      </form>
      <p class="small" style="margin-top:16px">一直無法重設？請在 Skool 私訊管理者，管理者可以給你一個重設連結。</p>`;
  return page("忘記密碼", `<h1>忘記密碼</h1>${msg(err)}${msg(note, "ok")}${body}<p class="small" style="margin-top:16px"><a href="/login">回登入頁</a></p>`);
}

// 改密碼：所有裝置都要重新登入
async function setNewPassword(env, u, pw) {
  const { salt, hash, iter } = await hashPassword(pw);
  u.salt = salt; u.hash = hash; u.iter = iter;
  for (const sid of u.sessions || []) await env.SITE_KV.delete(`sess:${sid}`);
  await setSessions(env, u.email, []);
  await putAccount(env, u);
}

// 沒有寄信功能時的自助重設：email＋綁定的 Skool 帳號＋本月驗證碼。
// 驗證碼是付費會員都看得到的，所以加上：次數限制、每個帳號一天一次、通知管理者、重設後所有裝置登出。
const RESET_DAY_SECONDS = 86400;
async function handleCodeReset(req, env, ip) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), handle = normHandle(f.get("skool")), code = normCode(f.get("code"));
  const pw = String(f.get("password") || ""), pw2 = String(f.get("password2") || "");
  const again = (err) => forgotPage(env, "", err, { email, handle });
  if ((await tooMany(env, `forgot:${ip}`, 10)) || (await tooMany(env, `forgot:${email}`, 5))) return again("嘗試次數太多，請 15 分鐘後再試。");
  if (pw.length < 8) return again("新密碼至少 8 碼。");
  if (pw !== pw2) return again("兩次輸入的新密碼不一樣。");
  const u = validEmail(email) ? await getUser(env, email) : null;
  const ok = u && u.status !== "disabled" && u.skool && safeEqual(handle, u.skool) && safeEqual(code, await monthCode(env, taipeiMonth()));
  if (!ok) {
    await addFail(env, `forgot:${ip}`); await addFail(env, `forgot:${email}`);
    return again("Email、Skool 帳號或本月驗證碼不正確。請確認是註冊時填的 email 和 Skool 帳號，以及「本月」的驗證碼。");
  }
  if (await env.SITE_KV.get(`rstday:${email}`)) return again("這個帳號今天已經重設過密碼了。如需再次重設，請在 Skool 私訊管理者。");
  await setNewPassword(env, u, pw);
  await env.SITE_KV.put(`rstday:${email}`, "1", { expirationTtl: RESET_DAY_SECONDS });
  if (env.ADMIN_EMAIL) {
    const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
    await sendMail(env, env.ADMIN_EMAIL, `會員自助重設密碼：${email}`,
      `${email}（Skool：@${u.skool}）在 ${when}（台北時間）用本月驗證碼重設了密碼，所有裝置已登出。\n\n如果對方說不是本人操作，請到管理頁幫他產生重設連結，必要時停用帳號。\n`);
  }
  return redirect("/login?m=reset");
}

async function handleForgot(req, env, ip, origin) {
  if (!selfResetOn(env)) return handleCodeReset(req, env, ip);
  if (await tooMany(env, `forgot:${ip}`, 5)) return forgotPage(env, "", "嘗試次數太多，請 15 分鐘後再試。");
  await addFail(env, `forgot:${ip}`); // 每次送出都計數，避免被拿來亂寄信
  const email = normEmail((await req.formData()).get("email"));
  // 不論 email 有沒有註冊都回同一句話，避免被用來查誰是會員
  const done = forgotPage(env, `如果這個 email 有註冊，重設密碼的信已經寄出，請在 ${RESET_HOURS_SELF} 小時內點信裡的連結。`);
  const u = validEmail(email) ? await getUser(env, email) : null;
  if (!u || u.status === "disabled") return done;
  const t = await createResetToken(env, email, RESET_HOURS_SELF);
  await sendMail(env, email, "重設你的籌碼力度選股密碼",
    `有人（希望是你）要求重設籌碼力度選股的密碼。\n\n請在 ${RESET_HOURS_SELF} 小時內點這個連結設定新密碼：\n${origin}/reset?t=${t}\n\n如果不是你本人操作，可以忽略這封信，密碼不會改變。\n`);
  return done;
}

const resetExpired = () => page("連結已失效", `<h1>連結已失效</h1><p>這個重設密碼的連結已經用過或過期了。</p><p><a href="/forgot">重新申請</a>・<a href="/login">回登入頁</a></p>`);

function resetPage(token, err = "") {
  return page("設定新密碼", `<h1>設定新密碼</h1>${msg(err)}
  <form method="post" action="/reset"><input type="hidden" name="t" value="${esc(token)}">
    <label for="password">新密碼（至少 8 碼）</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <label for="password2">再輸入一次</label><input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
    <button class="full" type="submit">更新密碼</button>
  </form>`);
}

async function handleReset(req, env, url) {
  if (req.method !== "POST") {
    const t = url.searchParams.get("t") || "";
    return t && (await env.SITE_KV.get(`rst:${t}`)) ? resetPage(t) : resetExpired();
  }
  const f = await req.formData();
  const t = String(f.get("t") || ""), pw = String(f.get("password") || ""), pw2 = String(f.get("password2") || "");
  const email = t && (await env.SITE_KV.get(`rst:${t}`));
  if (!email) return resetExpired();
  if (pw.length < 8) return resetPage(t, "密碼至少 8 碼。");
  if (pw !== pw2) return resetPage(t, "兩次輸入的密碼不一樣。");
  const u = await getUser(env, email);
  if (!u) return resetExpired();
  await setNewPassword(env, u, pw);
  await env.SITE_KV.delete(`rst:${t}`);
  return redirect("/login?m=reset");
}

async function handleLogin(req, env, ip) {
  const f = await req.formData();
  const email = normEmail(f.get("email")), password = String(f.get("password") || "");
  if ((await tooMany(env, `login:${ip}`, 20)) || (await tooMany(env, `login:${email}`))) return loginPage("嘗試次數太多，請 15 分鐘後再試。", "", email);
  const u = await getUser(env, email);
  const { hash } = await hashPassword(password, u ? u.salt : "00".repeat(16), u ? u.iter || LEGACY_ITER : PBKDF2_ITER);
  if (!u || !safeEqual(hash, u.hash)) {
    await addFail(env, `login:${ip}`); await addFail(env, `login:${email}`);
    return loginPage("Email 或密碼不正確。請輸入你在本站註冊時設的密碼（不是 Skool 密碼，Skool 改密碼也不會影響這裡）；忘記的話按下方「忘記密碼」。", "", email);
  }
  if (u.status === "disabled") return loginPage("這個帳號已停用，如有疑問請在 Skool 聯絡管理者。", "", email);
  if ((u.iter || LEGACY_ITER) !== PBKDF2_ITER) await putAccount(env, Object.assign(u, await hashPassword(password)));
  // 建立登入；超過裝置上限就把最舊的登出
  const sid = randomId();
  await env.SITE_KV.put(`sess:${sid}`, JSON.stringify({ email, created: Date.now() }), { expirationTtl: SESSION_DAYS * 86400 });
  u.sessions = [...(u.sessions || []), sid];
  while (u.sessions.length > MAX_DEVICES) await env.SITE_KV.delete(`sess:${u.sessions.shift()}`);
  await setSessions(env, email, u.sessions);
  return redirect("/", { "Set-Cookie": setCookie("sid", sid, SESSION_DAYS * 86400) });
}

async function handleLogout(req, env) {
  const cu = await currentUser(env, req);
  if (cu) {
    await env.SITE_KV.delete(`sess:${cu.sid}`);
    await setSessions(env, cu.user.email, cu.user.sessions.filter((s) => s !== cu.sid));
  }
  return redirect("/login?m=out", { "Set-Cookie": setCookie("sid", "", 0) });
}

async function handleVerify(req, env, ip, cu) {
  const code = normCode((await req.formData()).get("code"));
  if (await tooMany(env, `verify:${cu.user.email}`)) return verifyPage(env, cu.user.email, "嘗試次數太多，請 15 分鐘後再試。");
  if (!safeEqual(code, await monthCode(env, taipeiMonth()))) {
    await addFail(env, `verify:${cu.user.email}`);
    return verifyPage(env, cu.user.email, "驗證碼不正確，請確認是本月的驗證碼。");
  }
  await setVerified(env, cu.user.email, taipeiMonth());
  return redirect("/");
}

async function serveDashboard(env, cu) {
  const html = await env.SITE_KV.get("dashboard");
  if (!html) return statusPage("頁面準備中", "今天的資料還沒上傳，請稍後再來。", cu.user.email);
  const bar = `<div style="font:13px system-ui,sans-serif;display:flex;justify-content:flex-end;gap:12px;padding:8px 16px;color:#7a8085"><a href="/guide" style="color:inherit">使用說明</a><a href="/terms" style="color:inherit">條款</a>${esc(cu.user.email)}<a href="/logout" style="color:inherit">登出</a></div>`;
  return dashboardDoc(html, bar);
}

// 展示版：不用登入，資料是延遲約一個月的舊資料（由 build_dashboard.py 產生）。wrangler.toml 的 DEMO 設成 off 就關閉
const joinUrl = (env) => env.JOIN_URL || "https://www.skool.com/fosi-trading-1190/plans";
async function serveDemo(env) {
  const html = env.DEMO === "off" ? null : await env.SITE_KV.get("demo");
  if (!html) return page("展示版", `<h1>展示版暫停中</h1><p>想看完整內容，請加入 Skool 付費會員。</p><p><a href="${esc(joinUrl(env))}" target="_blank" rel="noopener">加入雷達席</a>・<a href="/login">會員登入</a></p>`, { status: 404 });
  const m = html.match(/"demo":\{"until":"(\d{8})"/);
  const until = m ? `${+m[1].slice(4, 6)}/${+m[1].slice(6)}` : "約一個月前";
  const bar = `<div style="font:14px/1.5 system-ui,sans-serif;background:#0b1d44;color:#fff;padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;justify-content:center;text-align:center">
    <span><b>展示版</b>・${until} 以前的資料完整開放；最近的交易日（🔒）只看得到檔數與產業。付費會員每個交易日 17:30 看到最新完整名單，還能追蹤個股、收到通知。</span>
    <a href="${esc(joinUrl(env))}" target="_blank" rel="noopener" style="background:#fff;color:#0b1d44;border-radius:999px;padding:4px 14px;font-weight:600;text-decoration:none">加入雷達席</a>
    <a href="/login" style="color:#cfe0ff">會員登入</a><a href="/guide" style="color:#cfe0ff">使用說明</a></div>`;
  return dashboardDoc(html.replaceAll("__JOIN_URL__", joinUrl(env).replace(/[^\w:/.?=&%#@~+-]/g, "")), bar);
}

function dashboardDoc(html, bar) {
  // dashboard.html 是不含 <html>/<body> 的頁面片段（原本給 Artifact 用），這裡補上完整骨架
  const doc = /<!doctype/i.test(html)
    ? html.replace(/<body([^>]*)>/i, (m) => m + bar)
    : `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${APP_HEAD}<script>try{var t=localStorage.getItem("cf-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}</script><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${bar}${html}</body></html>`;
  return new Response(doc, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
  });
}

// ---------- 使用說明（公開頁面，未登入也看得到） ----------
function guidePage(env) {
  const terms = [
    ["佔股本比", "法人當天買賣超佔公司股本的比例。同樣買一萬張，小型股會比大型股明顯。"],
    ["力度", "當天法人買超相對於這檔股票平常狀況的異常程度，數字越大越異常。力度高不代表之後一定會漲。"],
    ["顯著買超", "力度超過系統的顯著門檻，而且當天是買超。"],
    ["買方轉強", "法人買盤有轉強跡象，但力度還沒到顯著門檻。"],
    ["投信（投本比）", "只看投信的買賣超，用「穩健模式」，條件比較嚴格。"],
    ["外資", "外資及陸資（含外資自營商）的買賣超，用「靈敏模式」。"],
    ["冷門股排除", "成交量太少的股票不列入，避免少量交易就排到前面。"],
  ].map(([k, v]) => `<tr><td style="white-space:nowrap"><b>${k}</b></td><td>${v}</td></tr>`).join("");
  const toc = [["start", "第一次使用"], ["read", "頁面怎麼看"], ["week", "本週統整"], ["watch", "追蹤與通知"], ["detail", "個股明細"], ["terms", "名詞解釋"], ["time", "更新時間"], ["account", "帳號與密碼"], ["faq", "常見問題"], ["note", "聲明"]]
    .map(([id, t]) => `<a href="#${id}">${t}</a>`).join("・");
  return page("使用說明", `<h1>使用說明</h1><p>籌碼力度選股是 Skool 付費會員專屬的每日選股網站：每個交易日收盤後，從全市場上市櫃普通股中，找出「投信」與「外資」買超力道明顯異常的股票，附上力度排行、圖表、完整清單和個股明細。</p>
  <p class="small">${toc}</p>

  <h2 id="start">第一次使用</h2>
  <p>僅限訂閱 Skool <b>月費方案</b>的付費會員；免費會員無法開通。還不是會員？可以先看<a href="/demo">展示版</a>（約一個月前的資料，不用登入）。</p>
  <ol>
    <li>到 Skool 付費課程拿<b>本月驗證碼</b>（${skoolLink(env, "打開 Skool 課程")}）。</li>
    <li>到<a href="/register">註冊頁</a>填寫（並勾選同意<a href="/terms">服務條款</a>、<a href="/privacy">隱私權政策</a>與<a href="/refund">退款規則</a>）：
      <ul>
        <li><b>Email</b>：請用你 Skool 帳號的 email</li>
        <li><b>Skool 帳號</b>：個人檔案網址 skool.com/@ 後面那段，例如 @su-ray-2735（不是顯示名稱）。找法：Skool 右上角頭像 → 個人檔案 → 看網址</li>
        <li><b>本站密碼</b>：網站專用，不是 Skool 密碼，請設一組和 Skool 不同的密碼</li>
        <li><b>本月驗證碼</b></li>
      </ul>
    </li>
    <li>等管理者確認你是付費會員後開通，通常一天內。核准後約 1 分鐘生效，重新整理頁面即可。</li>
    <li>到<a href="/login">登入頁</a>登入，就能看每天的清單。</li>
  </ol>
  <p>已經註冊過的會員：下次進站時會被要求補填一次 Skool 帳號，填完就好。</p>
  <p><b>建議加到手機主畫面</b>，用起來就像 APP，點圖示就會全螢幕打開：</p>
  <ul>
    <li>iPhone：用 Safari 打開網站 → 下方「分享」→「加入主畫面」</li>
    <li>Android：用 Chrome 打開網站 → 右上角 ⋮ →「加到主畫面」或「安裝應用程式」</li>
  </ul>

  <h2 id="read">頁面怎麼看</h2>
  <ul>
    <li><b>交易日</b>：預設顯示最近 10 個交易日，按「更早」可以看更早以前的（最多 60 天）。</li>
    <li><b>看哪個法人</b>：切換「投信（投本比）」或「外資」。</li>
    <li><b>白天／夜晚</b>：右上「顯示」可以切換，會記住你的選擇；沒選過的話會跟著手機或電腦的設定。</li>
    <li><b>摘要卡</b>：力度最強的一檔、顯著買超檔數（含連續上榜、新上榜、雙榜幾檔）、買方轉強檔數，以及被成交量門檻濾掉幾檔。</li>
    <li><b>力度排行</b>：顯著買超前 15 名，長條越長代表力度越大。</li>
    <li><b>佔股本比與力度</b>：橫軸是佔股本比、縱軸是力度，虛線是顯著門檻。藍點是顯著買超、橘點是買方轉強；圓形是上市、菱形是上櫃。滑過或點一下點可以看詳細數字。</li>
    <li><b>產業分布</b>：清單裡的股票依產業分類，看法人資金集中在哪些產業。<b>點一個產業</b>，下面的完整清單就只顯示那個產業的股票；再點一次或按「✕ 顯示全部」恢復。</li>
    <li><b>官方產業與題材</b>：產業分布右上角可以切換「官方產業」或「題材」。<b>官方產業</b>是證交所的產業別，依公司登記的主要業務分類（例如鴻海是「其他電子業」）。<b>題材</b>是本站整理的市場題材，例如 AI伺服器、散熱、先進封裝、矽光子、重電；一檔可能有好幾個題材，也有很多股票沒有題材。題材不是官方分類，可能不完整或有出入，會持續更新。</li>
    <li><b>完整清單</b>：點欄位名稱可以排序，右上角可以搜尋代號或名稱。「產業」欄的標籤點一下也能直接篩選。「轉強」欄打勾代表同時符合買方轉強。</li>
    <li><b>收盤與漲跌%</b>：當天收盤價，以及和前一個交易日收盤相比的漲跌幅（紅漲綠跌）。除權息當天會和官方漲跌不同。</li>
    <li><b>市／櫃</b>：名稱前面的小方塊是市場，實心「市」＝上市、空心「櫃」＝上櫃。</li>
    <li><b>標記</b>：<b>🔥連3</b>＝連續 3 個交易日都上榜（法人可能在持續布局）；<b>新</b>＝近 10 個交易日第一次上榜；<b>⭐雙榜</b>＝投信和外資同一天都上榜。「連續上榜」欄可以排序，找出連續最多天的股票。</li>
  </ul>

  <h2 id="week">本週統整</h2>
  <p>上方「看什麼」切到<b>本週統整</b>，會把一週每天的清單合併成一張表，同一檔只列一次，不用每天重複看。</p>
  <ul>
    <li><b>哪一週</b>：預設是最新一週，可以切換到前幾週（最多約 12 週）。</li>
    <li><b>本週每天</b>：週一到週五各一格，藍色＝顯著買超、橘色＝買方轉強、空白＝沒上榜、虛線＝休市或還沒到。</li>
    <li><b>上榜天數</b>：例如「3 / 5」代表這週 5 個交易日裡有 3 天上榜，預設由多到少排。</li>
    <li><b>最強力度</b>：這週上榜那幾天裡最高的力度。<b>本週法人買賣超</b>：整週每天加起來的張數。<b>上榜後漲跌%</b>：從這週<b>第一次上榜那天</b>的收盤，算到這週最後一個交易日的收盤；重複上榜的以第一天為準，最後一天才上榜的顯示「剛上榜」。</li>
    <li>點任一檔一樣可以打開個股明細。</li>
    <li><b>提醒</b>：重複上榜代表法人這週連續在買，但不代表之後一定比較強。用過去一年的資料統計，一週上榜很多次的股票，在那一週通常已經漲了一段，之後的表現並沒有比只上榜一次的好。請把它當成「這週法人在忙什麼」的整理，不是買進清單。</li>
  </ul>

  <h2 id="watch">追蹤與通知</h2>
  <ul>
    <li><b>加入追蹤</b>：打開任一檔的個股明細，按右上角「☆ 追蹤」。追蹤的股票會出現在選股頁的「⭐ 我的追蹤」，清單裡名稱旁邊也會有 ★。最多 50 檔。</li>
    <li><b>我的追蹤</b>：顯示選到那一天，每檔在投信、外資有沒有上榜（藍＝顯著買超、橘＝買方轉強），以及最近一次上榜的日子。點一檔看明細，按 ✕ 取消追蹤。</li>
    <li><b>上榜通知</b>：在「我的追蹤」按「🔔 開啟上榜通知」並允許通知。之後每個交易日收盤更新完（約 17:40），你追蹤的股票有上榜就會通知你；沒有上榜就不會打擾你。每台裝置要各自開啟，一個帳號最多 3 台。</li>
    <li><b>iPhone／iPad</b>：需要 iOS 16.4 以上，而且要先把網站「加入主畫面」，<b>從主畫面的圖示打開</b>，才能開啟通知（用 Safari 分頁打開不行）。</li>
    <li><b>Android</b>：用 Chrome 打開就能開啟；加到主畫面更方便。</li>
    <li><b>收不到通知？</b>確認手機設定裡允許「籌碼力度選股」（或瀏覽器）的通知、沒有開勿擾或專注模式；也可以按「關閉」再重新開啟一次。還是不行的話，在 Skool 私訊管理者，管理者可以送一則測試通知給你。</li>
  </ul>

  <h2 id="detail">個股明細</h2>
  <p>點清單、力度排行或散布圖上的任一檔，就會打開明細（第一次會載入一兩秒）：</p>
  <ul>
    <li><b>上榜統計</b>：近 10 日上榜次數、近 60 日上榜次數、目前連續上榜天數、雙榜天數。</li>
    <li><b>法人買賣超</b>：近 60 個交易日的長條圖，紅色是買超、綠色是賣超；上方的圓點是上榜的日子（藍＝顯著買超、橘＝買方轉強）。</li>
    <li><b>力度走勢</b>：虛線是顯著門檻，看力度是突然衝高還是慢慢升溫。</li>
    <li><b>收盤價</b>：和法人動作對照著看。價格未還原除權息。</li>
    <li>可以在明細裡切換投信／外資；滑過或點圖表可以看每天的數字。按 ✕、Esc 或點旁邊空白處關閉。</li>
  </ul>

  <h2 id="terms">名詞解釋</h2>
  <div style="overflow-x:auto"><table><tbody>${terms}</tbody></table></div>

  <h2 id="time">更新時間</h2>
  <ul>
    <li>每個交易日 <b>17:30</b> 自動更新，通常 <b>17:40</b> 前完成。</li>
    <li>頁面最下方的「資料更新於」是最後更新時間。</li>
    <li>休市日不更新，頁面會維持前一個交易日的內容。</li>
  </ul>

  <h2 id="account">帳號與密碼</h2>
  <ul>
    <li><b>每月驗證</b>：每個月第一次進站要輸入當月的新驗證碼。驗證碼每月 1 號更新，放在 Skool 付費課程裡；輸入一次後，整個月都不用再輸入。</li>
    <li><b>一人一帳號</b>：一個 Skool 帳號只能綁定一個網站帳號，請勿共用或轉借。</li>
    <li><b>裝置數</b>：一個帳號最多同時 2 台裝置登入，第 3 台登入時最舊的那台會被登出。</li>
    <li><b>名單比對</b>：管理者會定期用 Skool 會員名單比對，非付費或共用帳號的情況會被停用。退訂後，下個月起就無法再看到內容。</li>
    <li><b>本站密碼和 Skool 密碼是分開的</b>：在 Skool 改密碼不會影響這裡。</li>
    <li><b>忘記密碼</b>：在登入頁按「忘記密碼？」，或直接到<a href="/forgot">忘記密碼</a>頁，輸入註冊時的 email、Skool 帳號和本月驗證碼，就能直接設定新密碼（每個帳號一天一次）。改完密碼後，所有裝置都需要重新登入。</li>
  </ul>

  <h2 id="faq">常見問題</h2>
  <ul>
    <li><b>密碼一直不對？</b>請輸入本站註冊時設的密碼，不是 Skool 密碼。想不起來就到<a href="/forgot">忘記密碼</a>自己重設。</li>
    <li><b>忘記密碼頁顯示資料不正確？</b>確認 email 和 Skool 帳號都是註冊時填的，驗證碼是「本月」的。還是不行的話，在 Skool 私訊管理者。</li>
    <li><b>驗證碼輸入錯誤？</b>確認是「本月」的碼，英文大小寫都可以。</li>
    <li><b>註冊後一直顯示等待核准？</b>管理者會盡快處理，通常一天內；超過一天請在 Skool 私訊管理者。</li>
    <li><b>Skool 帳號顯示「已經綁定其他 email」？</b>請在 Skool 私訊管理者處理。</li>
    <li><b>今天的資料還沒出來？</b>每個交易日 17:30 更新，請在 17:40 之後重新整理頁面。</li>
    <li><b>點股票打不開明細？</b>重新整理頁面再試一次；第一次打開需要載入一兩秒。</li>
  </ul>

  <h2 id="note">聲明</h2>
  <p>本站內容依證交所、櫃買中心公開的法人買賣超資料統計，<b>僅供研究與學習參考，不構成任何投資建議或買賣推薦</b>。統計結果不代表未來表現，請依自己的判斷與風險承受度做決定。</p>
  <p>使用本站即表示同意${LEGAL_LINKS}。</p>
  <p class="small" style="margin-top:20px"><a href="/">回到選股頁面</a>・<a href="/login">登入</a>・${skoolLink(env, "Skool 課程")}</p>`, { wide: true });
}

// ---------- 管理端 ----------
function adminLoginPage(err = "") {
  return page("管理登入", `<h1>管理頁</h1>${msg(err)}<form method="post" action="/admin/login">
  <label for="pw">管理密碼</label><input id="pw" name="password" type="password" required autofocus>
  <button class="full" type="submit">登入</button></form>`);
}

async function allUsers(env) {
  const names = [];
  let cursor;
  do {
    const r = await env.SITE_KV.list({ prefix: "user:", cursor });
    names.push(...r.keys.map((k) => k.name.slice(5)));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return (await Promise.all(names.map((e) => getUser(env, e)))).filter(Boolean);
}

const STATUS_LABEL = { pending: "待核准", active: "已開通", disabled: "已停用" };
const adminBtn = (email, action, text) => `<form class="inline" method="post" action="/admin/action"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="action" value="${action}"><button class="ghost" type="submit">${text}</button></form>`;
const handleCell = (u) => (u.skool ? `<a href="${esc(skoolProfile(u.skool))}" target="_blank" rel="noopener">@${esc(u.skool)}</a>` : `<span class="small">未填</span>`);

async function adminHome(env, note = "", extra = "") {
  const list = await allUsers(env);
  const order = { pending: 0, active: 1, disabled: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || a.created.localeCompare(b.created));
  const cur = taipeiMonth(), next = taipeiMonth(1);
  const rows = list.map((u) => `<tr><td>${esc(u.email)}</td><td>${handleCell(u)}</td><td><span class="tag">${STATUS_LABEL[u.status]}</span></td><td>${esc(u.created.slice(0, 10))}</td><td>${u.verified_month === cur ? "本月已驗證" : "本月未驗證"}</td><td>${u.sessions.length}</td><td class="row">${
    u.status === "pending" ? adminBtn(u.email, "approve", "核准") + adminBtn(u.email, "delete", "刪除")
      : u.status === "active" ? adminBtn(u.email, "resetlink", "重設密碼連結") + adminBtn(u.email, "disable", "停用") + adminBtn(u.email, "logout", "全部登出")
      : adminBtn(u.email, "approve", "重新開通") + adminBtn(u.email, "delete", "刪除")
  }${u.skool ? adminBtn(u.email, "clearskool", "清除 Skool 帳號") : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="small">還沒有人註冊。</td></tr>`;
  const counts = (s) => list.filter((u) => u.status === s).length;
  return page("管理頁", `<div style="display:flex;justify-content:space-between;align-items:center"><h1>管理頁</h1><a href="/admin/logout" class="small">登出管理頁</a></div>${msg(note, "ok")}${extra}
  <div class="cards">
    <div class="card"><div class="small">${monthLabel(cur)}驗證碼（貼到 Skool 課程）</div><div class="code">${await monthCode(env, cur)}</div></div>
    <div class="card"><div class="small">${monthLabel(next)}驗證碼（下個月 1 號換上）</div><div class="code">${await monthCode(env, next)}</div></div>
    <div class="card"><div class="small">會員</div><div style="font-size:20px">待核准 ${counts("pending")}・已開通 ${counts("active")}・已停用 ${counts("disabled")}</div></div>
  </div>
  <p class="small">核准前請到 Skool 確認對方是付費會員：點 Skool 帳號連結看他的個人檔案，或用下方「名單比對」。核准或停用後，最多約 1 分鐘生效。</p>
  <div style="overflow-x:auto"><table><thead><tr><th>Email</th><th>Skool 帳號</th><th>狀態</th><th>註冊日</th><th>每月驗證</th><th>登入裝置</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>

  <h2>名單比對</h2>
  <p class="small">到 Skool 社團的「會員」頁面，全選（Ctrl+A 或 ⌘A）→ 複製整頁 → 貼到下面。系統會找出每個 @帳號和他的方案（免費／付費），和本站會員對照。會員多、要往下捲或換頁時，可以分幾次貼，或一次把好幾頁的文字一起貼上。</p>
  <form method="post" action="/admin/action">
    <input type="hidden" name="action" value="compare">
    <textarea name="list" rows="6" required placeholder="把 Skool 會員頁面的文字貼在這裡"></textarea>
    <label style="display:flex;gap:8px;align-items:center;color:var(--ink-2)"><input type="checkbox" name="allpaid" value="1" style="width:auto">貼的是「只有付費會員」的清單（例如在 Skool 篩選付費方案後複製，或自己整理的 @帳號清單）</label>
    <button type="submit" style="margin-top:10px">比對</button>
  </form>`, { wide: true });
}

// 從 Skool 會員頁面複製的文字裡，找出每個 @帳號和緊接在後面的方案（「免費」或有金額的付費方案）
function parseSkoolList(text, allPaid) {
  const t = String(text || "");
  const hits = [...t.matchAll(/(?:^|[^a-z0-9._%+-])@([a-z0-9][a-z0-9-]{1,63})/gim)];
  const out = new Map();
  hits.forEach((m, i) => {
    const h = m[1].toLowerCase();
    if (allPaid) return out.set(h, { plan: "paid", label: "付費（清單）" });
    const seg = t.slice(m.index + m[0].length, i + 1 < hits.length ? hits[i + 1].index : undefined);
    const lines = seg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const paid = lines.find((l) => /\$\s*\d|\d\s*(美元|usd|twd)|\/\s*(月|mo)|每月|per month|monthly/i.test(l));
    const free = lines.find((l) => /^(免費|free)$/i.test(l));
    // 同一個帳號出現多次（例如貼了重複的頁面）時，以看得出方案的那次為準
    const prev = out.get(h);
    const now = paid ? { plan: "paid", label: paid } : free ? { plan: "free", label: free } : { plan: "unknown", label: "看不出方案" };
    if (!prev || prev.plan === "unknown") out.set(h, now);
  });
  return out;
}

async function compareList(env, text, allPaid) {
  const sk = parseSkoolList(text, allPaid);
  if (!sk.size) return adminHome(env, "", `<div class="msg bad">貼上的文字裡找不到任何 @帳號。請到 Skool 會員頁面全選複製整頁再貼一次。</div>`);
  const users = await allUsers(env);
  const groups = { approve: [], disable: [], ok: [], missing: [], nohandle: [], other: [] };
  for (const u of users) {
    const hit = u.skool && sk.get(u.skool);
    const plan = hit ? hit.plan : null;
    let g, advice, btns = "";
    if (!u.skool) { g = "nohandle"; advice = "還沒填 Skool 帳號（下次登入會被要求補填）"; }
    else if (!hit) { g = "missing"; advice = "不在貼上的名單裡（可能在別頁，或已離開社團）"; }
    else if (plan === "paid") {
      if (u.status === "pending") { g = "approve"; advice = "付費會員，可以核准"; btns = adminBtn(u.email, "approve", "核准"); }
      else if (u.status === "disabled") { g = "other"; advice = "付費會員，但目前停用"; btns = adminBtn(u.email, "approve", "重新開通"); }
      else { g = "ok"; advice = "付費會員，正常"; }
    } else if (plan === "free") {
      if (u.status === "active") { g = "disable"; advice = "Skool 顯示免費，建議停用"; btns = adminBtn(u.email, "disable", "停用"); }
      else if (u.status === "pending") { g = "disable"; advice = "Skool 顯示免費，不要核准"; btns = adminBtn(u.email, "delete", "刪除"); }
      else { g = "ok"; advice = "免費，已停用"; }
    } else { g = "other"; advice = "找到帳號但看不出方案，請到 Skool 確認"; }
    groups[g].push(`<tr><td>${esc(u.email)}</td><td>${handleCell(u)}</td><td><span class="tag">${STATUS_LABEL[u.status]}</span></td><td>${hit ? esc(hit.label) : "—"}</td><td>${advice}</td><td class="row">${btns}</td></tr>`);
  }
  const siteHandles = new Set(users.map((u) => u.skool).filter(Boolean));
  const paidNoAccount = [...sk].filter(([h, v]) => v.plan === "paid" && !siteHandles.has(h)).length;
  const section = (title, rows) => (rows.length ? `<h2>${title}（${rows.length}）</h2><div style="overflow-x:auto"><table><thead><tr><th>Email</th><th>Skool 帳號</th><th>狀態</th><th>Skool 方案</th><th>建議</th><th>操作</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : "");
  const c = (p) => [...sk.values()].filter((v) => v.plan === p).length;
  const html = `<div class="card" style="margin:12px 0"><b>名單比對結果</b>
    <p class="small">貼上的名單共 ${sk.size} 個 @帳號：付費 ${c("paid")}・免費 ${c("free")}・看不出方案 ${c("unknown")}。另有 ${paidNoAccount} 位付費會員還沒在本站註冊。</p>
    ${section("可以核准", groups.approve)}${section("建議停用或刪除", groups.disable)}${section("需要確認", groups.other)}${section("不在名單裡", groups.missing)}${section("還沒填 Skool 帳號", groups.nohandle)}${section("正常", groups.ok)}
    <p class="small">「不在名單裡」不一定代表退訂：Skool 會員頁一次只顯示一部分，請確認有把所有頁面都貼上，再決定要不要停用。</p></div>`;
  return adminHome(env, "", html);
}

async function adminAction(req, env, origin) {
  const f = await req.formData();
  const action = String(f.get("action") || "");
  if (action === "compare") return compareList(env, f.get("list"), f.get("allpaid") === "1");
  const email = normEmail(f.get("email"));
  const u = await getUser(env, email);
  if (!u) return adminHome(env, "找不到這個帳號。");
  const dropSessions = async () => { for (const s of u.sessions) await env.SITE_KV.delete(`sess:${s}`); await setSessions(env, email, []); };
  if (action === "approve") { await setStatus(env, email, "active"); return adminHome(env, `已開通 ${email}。約 1 分鐘內生效，請對方重新整理頁面。`); }
  if (action === "disable") { await setStatus(env, email, "disabled"); await dropSessions(); return adminHome(env, `已停用 ${email}`); }
  if (action === "logout") { await dropSessions(); return adminHome(env, `已將 ${email} 全部登出`); }
  if (action === "resetlink") {
    const link = `${origin}/reset?t=${await createResetToken(env, email, RESET_HOURS_ADMIN)}`;
    return adminHome(env, `已產生 ${email} 的重設密碼連結`, `<div class="card" style="margin:12px 0"><div class="small">把這個連結私訊給會員，${RESET_HOURS_ADMIN} 小時內有效、只能用一次：</div><input readonly value="${esc(link)}" onclick="this.select()" style="margin-top:6px;font-family:ui-monospace,monospace;font-size:13px"></div>`);
  }
  if (action === "clearskool") {
    await unbindHandle(env, u);
    u.skool = undefined;
    await putAccount(env, u);
    return adminHome(env, `已清除 ${email} 的 Skool 帳號，對方下次進站時會被要求重新填寫。`);
  }
  if (action === "delete") { await dropSessions(); await deleteUser(env, u); return adminHome(env, `已刪除 ${email}`); }
  return adminHome(env, "不明的操作。");
}

// ---------- 自選追蹤與推播通知（已開通、本月已驗證的會員才能用） ----------
const MAX_WATCH = 50, MAX_PUSH = 3;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
async function getJSON(env, key, dflt) {
  const v = await env.SITE_KV.get(key);
  try { return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vapidPublicKey(env) {
  let v = await getJSON(env, "vapid", null);
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    v = { public: b64url(await crypto.subtle.exportKey("raw", kp.publicKey)), d: jwk.d, created: new Date().toISOString() };
    await env.SITE_KV.put("vapid", JSON.stringify(v));
  }
  return v.public;
}
async function handleApi(req, env, cu, path) {
  const email = cu.user.email;
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (path === "/api/watch") {
    let items = await getJSON(env, `wl:${email}`, []);
    if (req.method === "POST") {
      const c = String(body.c || "").trim().toUpperCase();
      if (!/^[0-9]{4,6}[A-Z]?$/.test(c)) return json({ error: "代號不正確" }, 400);
      items = items.filter((x) => x.c !== c);
      if (body.on) {
        if (items.length >= MAX_WATCH) return json({ error: `最多追蹤 ${MAX_WATCH} 檔`, items }, 400);
        items.push({ c, n: String(body.n || "").slice(0, 20), m: body.m === "上櫃" ? "上櫃" : "上市" });
      }
      await env.SITE_KV.put(`wl:${email}`, JSON.stringify(items));
    }
    return json({ items, max: MAX_WATCH });
  }
  if (path === "/api/push/key") return json({ key: await vapidPublicKey(env) });
  if (path === "/api/push" && req.method === "POST") {
    const sub = body.sub || {};
    const ok = typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000
      && sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string";
    if (!ok) return json({ error: "通知訂閱資料不正確" }, 400);
    let subs = (await getJSON(env, `push:${email}`, [])).filter((x) => x.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) }, at: new Date().toISOString() });
    subs = subs.slice(-MAX_PUSH);   // 每個帳號最多 3 台裝置，最舊的移除
    await env.SITE_KV.put(`push:${email}`, JSON.stringify(subs));
    return json({ ok: true, devices: subs.length });
  }
  if (path === "/api/push/off" && req.method === "POST") {
    const subs = (await getJSON(env, `push:${email}`, [])).filter((x) => x.endpoint !== body.endpoint);
    await env.SITE_KV.put(`push:${email}`, JSON.stringify(subs));
    return json({ ok: true, devices: subs.length });
  }
  return json({ error: "not found" }, 404);
}

// ---------- 路由 ----------
// Cloudflare 排程 → 觸發 GitHub 每日選股（auto=true：當天已完成就略過）
async function triggerDaily(env) {
  if (!env.GH_TOKEN) return console.log("沒有設定 GH_TOKEN，略過觸發");
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/daily.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "chip-force-site", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs: { auto: "true" } }),
  });
  console.log("觸發每日選股", r.status, r.ok ? "" : await r.text());
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerDaily(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    // 主畫面圖示與 manifest：公開，不需要登入
    const asset = req.method === "GET" && appAsset(path);
    if (asset) return asset;
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
      if (path === "/admin/action" && req.method === "POST") return adminAction(req, env, url.origin);
      return adminHome(env);
    }

    if (path === "/register") return req.method === "POST" ? handleRegister(req, env, ip, url.origin) : registerPage(env);
    if (path === "/login") {
      if (req.method === "POST") return handleLogin(req, env, ip);
      const m = url.searchParams.get("m");
      return loginPage("", m === "out" ? "已登出。" : m === "reset" ? "密碼已更新，請用新密碼登入。" : "");
    }
    if (path === "/logout") return handleLogout(req, env);
    if (path === "/forgot") return req.method === "POST" ? handleForgot(req, env, ip, url.origin) : forgotPage(env);
    if (path === "/reset") return handleReset(req, env, url);
    if (path === "/guide") return guidePage(env);
    if (path === "/demo") return serveDemo(env);
    if (path === "/demo/series.json") {
      const js = env.DEMO === "off" ? null : await env.SITE_KV.get("demo_series");
      return new Response(js || "{}", { status: js ? 200 : 404, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    const legal = { "/terms": ["服務條款", termsBody], "/privacy": ["隱私權政策", privacyBody], "/refund": ["退款規則", refundBody] }[path];
    if (legal) return page(legal[0], `${legal[1]()}<p class="small" style="margin-top:24px">${LEGAL_LINKS}・<a href="/guide">使用說明</a>・<a href="/">回到網站</a></p>`, { wide: true });

    const cu = await currentUser(env, req);
    if (!cu) return redirect("/login");
    if (cu.user.status === "disabled") return statusPage("帳號已停用", "如有疑問請在 Skool 聯絡管理者。", cu.user.email);
    if (!cu.user.skool) return path === "/skool" && req.method === "POST" ? handleSkool(req, env, cu) : skoolPage(cu.user.email);
    if (cu.user.status === "pending") return statusPage("等待核准中", "管理者確認你是 Skool 付費會員後就會開通，通常一天內。管理者核准後約 1 分鐘內生效，請重新整理這一頁。", cu.user.email);
    if (cu.user.status !== "active") return statusPage("帳號已停用", "如有疑問請在 Skool 聯絡管理者。", cu.user.email);
    if (cu.user.verified_month !== taipeiMonth()) {
      if (path === "/verify" && req.method === "POST") return handleVerify(req, env, ip, cu);
      return verifyPage(env, cu.user.email);
    }
    if (path === "/" || path === "/verify") return serveDashboard(env, cu);
    if (path.startsWith("/api/")) return handleApi(req, env, cu, path);
    // 個股明細資料：和選股頁一樣，要已開通且完成本月驗證
    if (path === "/series.json") {
      const js = await env.SITE_KV.get("series");
      if (!js) return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(js, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=600" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
