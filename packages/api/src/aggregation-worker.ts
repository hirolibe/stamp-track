import { SQSEvent, SQSRecord } from "aws-lambda";
import { getPrisma } from "./db";
import { openDm, postDm } from "./slack";
import { ensureSecrets } from "./secrets";

const formatDuration = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
};

const parseDate = (value: string | Date) =>
  value instanceof Date ? value : new Date(value);

const groupDurations = (rows: { channel_id: string; seconds: number }[]) => {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.channel_id, (map.get(row.channel_id) || 0) + row.seconds);
  }
  return map;
};

const postAggregation = async (
  slackUserId: string,
  periodStart: Date,
  periodEnd: Date,
  durationsByChannel: Map<string, number>,
  otherSeconds: number,
  grossSeconds: number,
  trigger: string
) => {
  const channelId = await openDm(slackUserId);
  if (!channelId) return;

  const periodText = `${periodStart.toISOString()} ~ ${periodEnd.toISOString()}`;
  const entries = Array.from(durationsByChannel.entries());
  entries.sort((a, b) => b[1] - a[1]);

  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: trigger === "break" ? "休憩集計" : "退勤集計"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `期間: ${periodText}`
      }
    }
  ];

  if (entries.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "タスク記録はありません。" }
    });
  } else {
    for (const [channel, seconds] of entries) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `<#${channel}>: ${formatDuration(seconds)}` }
      });
    }
  }

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `その他: ${formatDuration(otherSeconds)} / 合計: ${formatDuration(grossSeconds)}`
    }
  });

  await postDm(channelId, blocks, "集計結果");
};

const computeTaskDurations = (
  tasks: { channel_id: string; started_at: Date; ended_at: Date | null }[],
  periodStart: Date,
  periodEnd: Date
) => {
  return tasks.map((task) => {
    const start = task.started_at;
    const end = task.ended_at ? task.ended_at : periodEnd;
    const clipStart = start > periodStart ? start : periodStart;
    const clipEnd = end < periodEnd ? end : periodEnd;
    const seconds = Math.max(0, (clipEnd.getTime() - clipStart.getTime()) / 1000);
    return { channel_id: task.channel_id, seconds };
  });
};

const handleRecord = async (record: SQSRecord) => {
  const prisma = getPrisma();
  const payload = JSON.parse(record.body);
  const slackUserId: string = payload.slack_user_id;
  const userId: string = payload.user_id;
  const trigger: string = payload.trigger || "checkout";
  const periodStart = parseDate(payload.period_start);
  const periodEnd = parseDate(payload.period_end);

  const tasks = await prisma.taskSession.findMany({
    where: {
      user_id: userId,
      started_at: { lt: periodEnd },
      OR: [{ ended_at: null }, { ended_at: { gt: periodStart } }]
    }
  });

  const clipped = computeTaskDurations(tasks, periodStart, periodEnd);
  const durationsByChannel = groupDurations(clipped);
  const grossSeconds = Math.max(0, (periodEnd.getTime() - periodStart.getTime()) / 1000);
  const taskSeconds = Array.from(durationsByChannel.values()).reduce((a, b) => a + b, 0);
  const otherSeconds = Math.max(0, grossSeconds - taskSeconds);

  await postAggregation(
    slackUserId,
    periodStart,
    periodEnd,
    durationsByChannel,
    otherSeconds,
    grossSeconds,
    trigger
  );
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    await handleRecord(record);
  }
};
