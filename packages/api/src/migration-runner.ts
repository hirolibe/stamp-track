import { getPrisma } from "./db";
import { ensureSecrets } from "./secrets";

const migrations = [
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
