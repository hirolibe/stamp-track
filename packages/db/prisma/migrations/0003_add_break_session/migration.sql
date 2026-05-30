-- CreateTable
CREATE TABLE "BreakSession" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "started_at" timestamptz NOT NULL,
    "ended_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "BreakSession_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BreakSession" ADD CONSTRAINT "BreakSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
