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
