# 會員網站（Cloudflare Worker）

Skool 付費會員專屬的籌碼力度頁面。網址：`https://chip-force-site.<你的 workers 子網域>.workers.dev`

## 會員怎麼用
1. 到 `/register` 用 email、**Skool 帳號**（個人檔案網址 `skool.com/@` 後面那段）、密碼、**本月驗證碼**註冊（驗證碼貼在 Skool 付費課程裡）。一個 Skool 帳號只能綁一個 email；舊會員下次進站會被要求補填一次。
2. 等管理者核准後，到 `/login` 登入就能看每天的頁面（最近 60 個交易日）。
3. 每個月第一次進站要輸入新的驗證碼。退訂的人拿不到新碼，下個月就進不來。
4. 每個帳號最多同時 2 台裝置登入，第 3 台登入會把最舊的登出。
5. 本站密碼和 Skool 密碼是分開的（註冊頁、登入頁、登入失敗訊息、使用說明都有提醒），Skool 改密碼不影響本站。
6. 忘記密碼：到 `/forgot`。沒有寄信網域時，會員輸入 email＋綁定的 Skool 帳號＋本月驗證碼就能直接設定新密碼（每個帳號一天一次、同一 email 15 分鐘內錯 5 次就鎖、每次重設都寄通知信給管理者、重設後所有裝置登出）；驗證碼是付費會員共用的，所以理論上知道別人 email 與 Skool 帳號的會員可以重設別人密碼，收到通知信時留意。管理者也可以在 `/admin` 按「重設密碼連結」給會員（24 小時內有效、只能用一次）。設定 `SITE_MAIL_FROM`（Resend 已驗證網域）後，自動改成寄信重設（連結 1 小時內有效）。
7. 使用說明：`/guide`，未登入也看得到；登入頁、註冊頁、驗證頁和選股頁上方都有連結。
8. 法律頁面（公開）：`/terms` 服務條款、`/privacy` 隱私權政策、`/refund` 退款規則，內容在 `site/legal.js`（律師審閱後直接改那個檔案；條款內容有變時，`TERMS_VERSION` 也要改）。註冊時必須勾選同意，帳號會記錄同意的版本（`user:` 的 `agreed`）。
9. 展示版 `/demo`（公開、不用登入）：`build_dashboard.py` 用延遲 20 個交易日的 10 天資料產生 `output/demo.html`、`demo_series.json`，`upload.sh` 上傳到 KV `demo`、`demo_series`。最近 5 個交易日顯示 🔒：只看得到檔數、連續上榜／新上榜／雙榜幾檔與前 5 大產業，名單區是模糊的假資料（真的名單不會送到展示版）。上方與解鎖按鈕連到付費方案（`wrangler.toml` 的 `JOIN_URL`）。不想公開時把 `wrangler.toml` 的 `DEMO` 改成 `"off"` 再部署。
10. 題材標籤：`data/themes.csv`（本站自己整理，不是官方分類），一行一個題材：`題材,代號（空白隔開）,說明`，一檔可以出現在多個題材。直接在 GitHub 網頁上編輯這個檔案存檔，會自動觸發「部署會員網站」重建頁面（約 3 分鐘生效）；每天的選股也會用最新的表。代號寫錯（不存在）不會出錯，只是不會顯示。
11. 自選追蹤與上榜通知：會員在個股明細按「☆ 追蹤」（KV `wl:<email>`，最多 50 檔），選股頁有「⭐ 我的追蹤」。按「🔔 開啟上榜通知」會註冊 `/sw.js` 並把瀏覽器的推播訂閱存到 `push:<email>`（每帳號最多 3 台裝置）；推播金鑰 `vapid` 在第一次有人開通知時由 Worker 產生。每日流程上傳頁面後執行 `notify.py`：追蹤的股票當天上榜（任一法人的顯著買超或買方轉強）就推播，只送給已開通且本月已驗證的會員，同一個交易日只送一次（KV `notified`）。iPhone 要 iOS 16.4 以上、加入主畫面後從主畫面打開才能開通知。要確認某位會員收得到，手動執行 Actions 的「測試上榜通知」並填他的 email。

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
| `SITE_GH_TOKEN` | 選填但建議：只能觸發本 repo 工作流程的 GitHub token（fine-grained，Repository access 只選 `chip-force`，權限 Actions: Read and write）。設定後，Worker 的 Cloudflare 排程會在台北 17:30 起準時觸發每日選股 |
| `SITE_MAIL_FROM` | 選填：寄件人，例如 `籌碼力度選股 <noreply@你的網域>`；沒有驗證網域就不要設（會用 onboarding@resend.dev） |

設好或修改 secrets 後，都要到 Actions 執行一次「部署會員網站」才會生效。之後每天的選股跑完會自動把新頁面上傳。

## 已知限制與之後可以加的功能
- 驗證碼以「月份」為單位，跟會員各自的扣款日無關。取消訂閱的人最多還能看到當月月底（目前接受這個缺口）。
- 名單比對（`/admin` 最下方）：到 Skool 社團「會員」頁全選複製整頁貼上，系統依每個 @帳號後面的方案文字（「免費」或有金額）判斷免費／付費，列出可核准、建議停用、需要確認、不在名單裡的會員，按鈕只做單筆操作、不會自動停用。Skool 會員頁一次只顯示一部分，「不在名單裡」不一定是退訂。付費方案的文字如果判斷不出來（顯示「看不出方案」），可以勾選「只有付費會員的清單」改貼付費會員的 @帳號清單。會員填錯 Skool 帳號時，按「清除 Skool 帳號」讓他重填。
- 之後可買自己的網域（Cloudflare Registrar 約每年 10 美元）：在 Resend 驗證後設定 `SITE_MAIL_FROM`，會員就能自己收信重設密碼；網站也可改用自己的網址。在那之前，忘記密碼都由管理者在 `/admin` 產生重設連結。
