import { getPrisma } from "./db";
import { ensureSecrets } from "./secrets";

const migrations = [
  {
    name: "0001_init",
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'User') THEN
          CREATE EXTENSION IF NOT EXISTS "pgcrypto";

          CREATE TABLE "User" (
              "id" uuid NOT NULL DEFAULT gen_random_uuid(),
              "slack_user_id" text NOT NULL,
              "slack_team_id" text,
              "created_at" timestamptz NOT NULL DEFAULT now(),
              "updated_at" timestamptz NOT NULL DEFAULT now(),
              CONSTRAINT "User_pkey" PRIMARY KEY ("id")
          );

          CREATE UNIQUE INDEX "User_slack_user_id_key" ON "User"("slack_user_id");

          CREATE TABLE "WorkSession" (
              "id" uuid NOT NULL DEFAULT gen_random_uuid(),
              "user_id" uuid NOT NULL,
              "clock_in_at" timestamptz NOT NULL,
              "clock_out_at" timestamptz,
              "created_at" timestamptz NOT NULL DEFAULT now(),
              "updated_at" timestamptz NOT NULL DEFAULT now(),
              CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
          );

          CREATE TABLE "TaskSession" (
              "id" uuid NOT NULL DEFAULT gen_random_uuid(),
              "user_id" uuid NOT NULL,
              "channel_id" text NOT NULL,
              "thread_ts" text NOT NULL,
              "started_at" timestamptz NOT NULL,
              "ended_at" timestamptz,
              "created_at" timestamptz NOT NULL DEFAULT now(),
              "updated_at" timestamptz NOT NULL DEFAULT now(),
              CONSTRAINT "TaskSession_pkey" PRIMARY KEY ("id")
          );

          CREATE TABLE "SlackEvent" (
              "event_id" text NOT NULL,
              "event_type" text NOT NULL,
              "received_at" timestamptz NOT NULL DEFAULT now(),
              "payload_hash" text,
              CONSTRAINT "SlackEvent_pkey" PRIMARY KEY ("event_id")
          );

          ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          ALTER TABLE "TaskSession" ADD CONSTRAINT "TaskSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `
  },
  {
    name: "0002_add_dm_channel_id",
    sql: `ALTER TABLE "TaskSession" ADD COLUMN IF NOT EXISTS "dm_channel_id" TEXT;`
  },
  {
    name: "0002_add_dm_message_ts",
    sql: `ALTER TABLE "TaskSession" ADD COLUMN IF NOT EXISTS "dm_message_ts" TEXT;`
  },
  {
    name: "0003_add_break_session",
    sql: `
      -- Check if table already exists
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'BreakSession') THEN
          CREATE TABLE "BreakSession" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "user_id" uuid NOT NULL,
            "started_at" timestamptz NOT NULL,
            "ended_at" timestamptz,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "BreakSession_pkey" PRIMARY KEY ("id")
          );
          ALTER TABLE "BreakSession" ADD CONSTRAINT "BreakSession_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `
  }
];

export const handler = async () => {
  await ensureSecrets();
  const prisma = getPrisma();

  console.log("Running migrations...");

  const results: { name: string; status: string; error?: string }[] = [];

  for (const migration of migrations) {
    console.log(`Running migration: ${migration.name}`);
    try {
      await prisma.$executeRawUnsafe(migration.sql);
      results.push({ name: migration.name, status: "success" });
      console.log(`Migration ${migration.name} completed successfully`);
    } catch (error: any) {
      console.error(`Migration ${migration.name} failed:`, error.message);
      results.push({ name: migration.name, status: "failed", error: error.message });
    }
  }

  const hasFailure = results.some((r) => r.status === "failed");

  return {
    statusCode: hasFailure ? 500 : 200,
    body: JSON.stringify({ results })
  };
};
