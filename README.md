# stamp-track

Slack reaction-based time tracking (:task_start: / :task_end:) with AWS Lambda, API Gateway, SQS, and RDS (PostgreSQL).

## Requirements
- Node.js 20+
- Docker (for local Postgres)
- Slack App with Events API + Bot token

## Local setup
1. Start Postgres:
   ```bash
   docker compose up -d
   ```
2. Set env vars:
   ```bash
   export DATABASE_URL="postgresql://stamp:stamp@localhost:15432/stamp_track"
   export SLACK_SIGNING_SECRET="..."
   export SLACK_BOT_TOKEN="xoxb-..."
   export AGGREGATION_QUEUE_URL="https://sqs..." # optional for local
   ```
3. Install deps and generate Prisma client:
   ```bash
   npm install
   npm run prisma:generate
   ```
4. Create DB schema:
   ```bash
   npm run prisma:migrate
   ```

## Slack App settings
- Event Subscriptions:
  - `reaction_added`
  - `user_change`
  - (optional) `reaction_removed`
- Request URL: API Gateway `/slack/events`
- Scopes:
  - `reactions:read`
  - `chat:write`
  - `im:write`
  - `users:read`
  - `channels:history` (public channel threads)
  - `groups:history` (private channel threads)
  - `users:read.email` (if needed)

## Build
```bash
npm run build
```

## Lambda packaging note
- `npm run build` now bundles code and prepares Lambda ZIP contents under `packages/api/dist/lambda/*`.
- Terraform zips those directories when applying.

## Deploy (Terraform)
1. Configure AWS credentials.
2. Copy `infra/terraform/terraform.tfvars.example` to `infra/terraform/terraform.tfvars` and set values.
3. Build the Lambda bundles:
   ```bash
   npm run build
   ```
4. Apply:
   ```bash
   terraform -chdir=infra/terraform init
   terraform -chdir=infra/terraform apply
   ```

## Lambda handlers
- `packages/api/src/events-handler.ts`: Slack Events API receiver (VPC外)
- `packages/api/src/events-worker.ts`: DB 처리 + Slack reply enqueue (VPC内)
- `packages/api/src/aggregation-worker.ts`: 集計 (VPC内)
- `packages/api/src/slack-notifier.ts`: Slack返信/DM送信 (VPC外)

## Secrets
- Lambda will load secrets from Secrets Manager if `APP_SECRETS_ARN` is set.
- The secret JSON should contain:
  - `DATABASE_URL`
  - `SLACK_BOT_TOKEN`
  - `SLACK_SIGNING_SECRET`

## Notes
- User status emoji `:kyukei_chu:` or `:taikin_zumi:` closes the work session.
- DM includes only a permalink to the thread when `:task_start:` is used.
