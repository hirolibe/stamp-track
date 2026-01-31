# Codex実装プロンプト：Slackタイムトラッキング（reactions版 / Terraform+RDS+SQS+Lambda）

あなたは熟練のバックエンド/クラウドエンジニアです。以下仕様に従って、動くコード一式を実装してください。  
実装言語は **TypeScript（Node.js 20）**。AWSは **Lambda + API Gateway + SQS + RDS(PostgreSQL)**。IaCは **Terraform**。  
Slack App（Bot）と連携し、Slackのリアクション（`:start:` / `:end:`）とユーザーステータス変更から記録・集計します。

---

## 1. ゴール（ユーザー体験）

### タスク開始/自動クローズ/完了メッセージ（スレッド返信）
ユーザーがスレッド（親メッセージ）にリアクションを付与したとき、Botが**元のスレッドに返信**して状況を案内する。

- `:start:` 成功時（開始/再開共通）  
  **「タスクの実行を開始しました！:hi:」**

- あるタスクが実行中のまま、別スレッドで `:start:` が押され、前タスクが自動クローズされた場合  
  自動クローズされた元スレッドに返信：  
  **「他のタスクを実行中です！再開するには:start:を押し直してください！🙇」**

- 同一スレッドで `:start:` 連打（そのスレッドにすでにactiveがある）  
  **「すでにタスクの実行が開始されています！」**

- `:end:` 成功（そのスレッドにactiveがある）  
  **「タスクが完了しました！🎉」**

- `:end:` 連打/未開始（そのスレッドにactiveがない）  
  **「まだタスクの実行が開始されていません！」**

### DM通知（リンクのみ）
ユーザーが `:start:` を押したら、BotはそのユーザーのDMへ **元スレッドのリンクのみ**を送信する。

---

## 2. 前提ルール（重要）

### A案：同時に実行中のタスクは「ユーザーごとに最大1件」
- `task_sessions` は「開始〜終了」の区間レコード
- ユーザーが `:start:` を押したとき、すでに別スレッドでactiveがあれば **自動クローズ**する
- 自動クローズ時は **`:end:` を付与しない**（Slack上の`:end:`は手動終了の印）

### 再開の操作
- 「再開」はボタンを使わず、ユーザーが**いったん`:start:`を外して付け直す**ことで行う
- Botは `reaction_added(:start:)` のたびに通常の開始処理を行う（同一スレッドでactiveなら「開始済み」返信）

### 勤務外ガード（推奨）
- `:start:` 受信時、**openな work_session が無い場合は task_session を作らない**
- その場合、スレッドへ返信：  
  **「現在は勤務時間外です。出勤後に:start:を押してください。」**
- `:end:` は勤務外でも、該当スレッドにactiveがあるなら閉じてよい（イベント遅延対策）

---

## 3. Slack連携（Events / API）

### 受信するイベント
- Events API：
  - `reaction_added`（必須）
  - `user_change`（勤務ステータス監視のため）
  - （任意）`reaction_removed`（現時点の仕様では必須ではない。購読しても良いがロジックは最小限でOK）
- リクエスト署名検証：`X-Slack-Signature` と `X-Slack-Request-Timestamp` を検証

### Slack API（送信で使用）
- `chat.postMessage`：スレッド返信、DM送信
- `conversations.open`：DMチャネル取得
- `chat.getPermalink`：スレッドURL取得

### スコープ（目安）
- `reactions:read`
- `chat:write`
- `im:write`
- `users:read`（ユーザー情報が必要なら）
- `users:read.email`（必要なら）
- `channels:read` / `groups:read` は要件に応じて

---

## 4. データ設計（PostgreSQL / RDS）

### テーブル：users
- `id` uuid pk
- `slack_user_id` text unique not null
- `slack_team_id` text null
- `created_at`, `updated_at`

### テーブル：work_sessions（勤務セッション）
日跨ぎ/休憩対応のため「1日1行」ではなくセッション方式にする。1日に複数行OK。
- `id` uuid pk
- `user_id` uuid fk users
- `clock_in_at` timestamptz not null
- `clock_out_at` timestamptz null
- `created_at`, `updated_at`

### テーブル：task_sessions（タスクセッション）
- `id` uuid pk
- `user_id` uuid fk users
- `channel_id` text not null
- `thread_ts` text not null  （親メッセージtsをスレッドIDとして扱う）
- `started_at` timestamptz not null
- `ended_at` timestamptz null
- `created_at`, `updated_at`

> インデックスは後回しでOK（ただし `slack_events.event_id` のPKは必須）。

### テーブル：slack_events（イベント重複排除）
- `event_id` text pk
- `event_type` text not null
- `received_at` timestamptz not null
- `payload_hash` text null

---

## 5. 勤務ステータス（user_change）と集計ジョブ（SQS）

### 勤務ステータス判定
Slackのユーザーステータス絵文字が以下のとき「退勤/休憩扱い」で work_session を閉じる。
- `:kyukei_chu:` または `:taikin_zumi:`

それ以外に切り替わったときは「出勤扱い」で work_session を開く。

### user_change処理
- 出勤側へ切替：
  - openな work_session が無ければ新規作成（clock_in_at=now）
- 退勤/休憩側へ切替：
  - openな work_session があれば close（clock_out_at=now）
  - その時点でユーザーのactive task_sessionがあれば close（ended_at=now）
  - **集計ジョブをSQSへ投入**（Slack返信は不要）

### SQS集計ジョブ
- `checkout/break` をトリガーに、SQSへ `{ user_id, period_start, period_end, slack_user_id, trigger }` を送る
- 別Lambda（worker）がSQSを処理し、指定期間の集計を行って DM に投稿する

---

## 6. 集計仕様（worker Lambda）

### 集計対象
- 退勤/休憩で閉じた work_session の期間（`clock_in_at`〜`clock_out_at`）を対象期間とする（推奨）
- 期間内の task_sessions を「区間の交差（クリップ）」で按分して合計する

### クリップ（区間交差）
対象期間 `[period_start, period_end)` とタスク区間 `[started_at, ended_at)` の重なりのみを加算：
- `clip_start = max(started_at, period_start)`
- `clip_end = min(ended_at, period_end)`
- `duration = max(0, clip_end - clip_start)`

### 集計結果
- `gross = period_end - period_start`
- チャンネル別に task合計（`channel_id`でgroup）
- `other = max(0, gross - sum(all_task_durations))`
- 結果を Bot DM に投稿（Block Kitで見やすく）

---

## 7. reaction_added ロジック（重要：この通りに実装）

### `reaction_added`（reaction=`start`）
1. `slack_events` で event_id をPK insert（重複なら即return）
2. users upsert（slack_user_id）
3. openな work_session が無い場合：
   - スレッド返信「現在は勤務時間外です。出勤後に:start:を押してください。」
   - return
4. 同一スレッド（U×S）に active task_session があるなら：
   - スレッド返信「すでにタスクの実行が開始されています！」
   - return
5. ユーザーUに別スレッドの active task_session があるなら：
   - そのセッションを `ended_at=now` で自動クローズ
   - **その旧スレッドに返信**  
     「他のタスクを実行中です！再開するには:start:を押し直してください！🙇」
6. 新しい task_session を作成（S, started_at=now）
7. 今回のスレッドに返信「タスクの実行を開始しました！:hi:」
8. Bot DMで permalink を「リンクのみ」で送信

### `reaction_added`（reaction=`end`）
1. `slack_events` で event_id をPK insert（重複なら即return）
2. 同一スレッド（U×S）に active task_session があるなら：
   - `ended_at=now` で close
   - スレッド返信「タスクが完了しました！🎉」
3. 無いなら：
   - スレッド返信「まだタスクの実行が開始されていません！」

---

## 8. アーキテクチャ / リポジトリ構成

### 構成（AWS）
- API Gateway（HTTP API）
  - `POST /slack/events`：Events API
- Lambda：events-handler（Slackイベント受信）
- SQS：aggregation-queue
- Lambda：aggregation-worker（SQSトリガー）
- RDS：PostgreSQL
- Secrets Manager：Slack secrets / DB接続情報

### リポジトリ案
- `/infra/terraform`：Terraform一式（API GW, Lambda, SQS, IAM, RDS, SG, VPC等）
- `/packages/api`：Lambda handlers（events, worker）+ Slack client
- `/packages/db`：Prisma schema/migrations（または Kysely/Drizzleでも可。Prisma推奨）
- `docker-compose.yml`：ローカルPostgres
- `README.md`：Slack App設定手順、ローカル起動、デプロイ手順

---

## 9. 実装要件（品質）
- Slack署名検証を必ず実装
- Slackの `url_verification` に対応
- 重複排除（slack_eventsのPK insertをトランザクション的に使う）
- workerは冪等（同じwork_sessionに対して二重投稿しない工夫：`aggregation_jobs` テーブル追加などは任意）
- JSTの取り扱いを明示（表示はJST、保存はtimestamptz）

---

## 10. 成果物
- 動くコード一式（TypeScript）
- Terraform（RDS/SQS/Lambda/API Gateway）
- DBスキーマ（Prisma推奨）
- ローカル起動手順（Slack署名検証含む）
- 必要なSlack scopes / 設定手順
- 最低限のユニットテスト（区間クリップ、start/end分岐）

---

この仕様で実装を開始してください。まずはリポジトリ雛形、Terraformの最小構成、DBスキーマ、Slackイベント受信エンドポイント、start/endのロジックを実装し、ローカルで動作確認できるところまで作ってください。
