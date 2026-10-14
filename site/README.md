# 會員網站（Cloudflare Worker）

Skool 付費會員專屬的籌碼力度頁面。網址：`https://chip-force-site.<你的 workers 子網域>.workers.dev`

## 會員怎麼用
1. 到 `/register` 用 email、密碼、**本月驗證碼**註冊（驗證碼貼在 Skool 付費課程裡）。
2. 等管理者核准後，到 `/login` 登入就能看每天的頁面（最近 60 個交易日）。
3. 每個月第一次進站要輸入新的驗證碼。退訂的人拿不到新碼，下個月就進不來。
4. 每個帳號最多同時 2 台裝置登入，第 3 台登入會把最舊的登出。
5. 本站密碼和 Skool 密碼是分開的（註冊頁、登入頁、登入失敗訊息、使用說明都有提醒），Skool 改密碼不影響本站。
6. 忘記密碼：到 `/forgot`。沒有驗證寄件網域時，頁面會請會員到 Skool 私訊管理者；管理者在 `/admin` 按「重設密碼連結」，把產生的連結（24 小時內有效、只能用一次）私訊給會員。設定 `SITE_MAIL_FROM`（Resend 已驗證網域）後，會員可以自己收信重設（連結 1 小時內有效）。改密碼後所有裝置都要重新登入。
6. 使用說明：`/guide`，未登入也看得到；登入頁、註冊頁、驗證頁和選股頁上方都有連結。

## Skool 課程網址
註冊頁、驗證頁、使用說明會連到放驗證碼的 Skool 課程。網址在 `site/wrangler.toml` 的 `[vars] SKOOL_URL`，改了推上去就會自動重新部署。

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

## 已知限制與之後可以加的功能
- 驗證碼以「月份」為單位，跟會員各自的扣款日無關。取消訂閱的人最多還能看到當月月底（目前接受這個缺口）。
- 之後可加「名單比對」：管理者把 Skool 目前付費會員的 email 貼進 `/admin`，系統自動停用不在名單上的帳號。
- 之後可買自己的網域（Cloudflare Registrar 約每年 10 美元）：在 Resend 驗證後設定 `SITE_MAIL_FROM`，會員就能自己收信重設密碼；網站也可改用自己的網址。在那之前，忘記密碼都由管理者在 `/admin` 產生重設連結。
