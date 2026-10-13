# 會員網站（Cloudflare Worker）

Skool 付費會員專屬的籌碼力度頁面。網址：`https://chip-force-site.<你的 workers 子網域>.workers.dev`

## 會員怎麼用
1. 到 `/register` 用 email、密碼、**本月驗證碼**註冊（驗證碼貼在 Skool 付費課程裡）。
2. 等管理者核准後，到 `/login` 登入就能看每天的頁面（最近 60 個交易日）。
3. 每個月第一次進站要輸入新的驗證碼。退訂的人拿不到新碼，下個月就進不來。
4. 每個帳號最多同時 2 台裝置登入，第 3 台登入會把最舊的登出。

## 管理者每月要做的事
- 每月 1 號：打開 `/admin`，把「本月驗證碼」貼到 Skool 付費課程（管理頁也會先顯示下個月的碼）。
- 有人註冊時：到 Skool 用 email 確認是付費會員，再到 `/admin` 按「核准」。退訂或違規的人可以「停用」。

## 第一次部署前要設定的 repo secrets（Settings → Secrets and variables → Actions）
| 名稱 | 內容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 跟 money-goals 用的同一把（需要 Workers Scripts:Edit、Workers KV Storage:Edit） |
| `CLOUDFLARE_ACCOUNT_ID` | 跟 money-goals 同一個 |
| `SITE_SECRET` | 一長串隨機字（用來產生每月驗證碼；改掉會讓驗證碼全部改變） |
| `SITE_ADMIN_PASSWORD` | 管理頁 `/admin` 的密碼 |
| `RESEND_API_KEY` | 選填：Resend 的 API key，有人註冊時寄信通知管理者 |
| `SITE_ADMIN_EMAIL` | 選填：收通知的 email。Resend 沒有驗證網域時，只能寄到你註冊 Resend 的那個 email |
| `SITE_MAIL_FROM` | 選填：寄件人，例如 `籌碼力度選股 <noreply@你的網域>`；沒有驗證網域就不要設（會用 onboarding@resend.dev） |

設好或修改 secrets 後，都要到 Actions 執行一次「部署會員網站」才會生效。之後每天的選股跑完會自動把新頁面上傳。
