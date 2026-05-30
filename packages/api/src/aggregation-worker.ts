import { SQSEvent, SQSRecord } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getPrisma } from "./db";
import { ensureSecrets } from "./secrets";
import { SlackReplyMessage } from "./messages";

const replyQueueUrl = process.env.SLACK_REPLY_QUEUE_URL || "";
const sqsClient = new SQSClient({});

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

const sendReply = async (message: SlackReplyMessage) => {
  if (!replyQueueUrl) return;
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: replyQueueUrl,
      MessageBody: JSON.stringify(message)
    })
  );
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

const computeBreakDurations = (
  breaks: { started_at: Date; ended_at: Date | null }[],
  periodStart: Date,
  periodEnd: Date
) => {
  return breaks.reduce((total, brk) => {
    const start = brk.started_at;
    const end = brk.ended_at ? brk.ended_at : periodEnd;
    const clipStart = start > periodStart ? start : periodStart;
    const clipEnd = end < periodEnd ? end : periodEnd;
    const seconds = Math.max(0, (clipEnd.getTime() - clipStart.getTime()) / 1000);
    return total + seconds;
  }, 0);
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

  const breaks = await prisma.breakSession.findMany({
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
  const breakSeconds = computeBreakDurations(breaks, periodStart, periodEnd);
  const otherSeconds = Math.max(0, grossSeconds - taskSeconds - breakSeconds);
  const channelMap = new Map<string, { seconds: number; tasks: typeof tasks }>();
  for (const [channelId, seconds] of durationsByChannel.entries()) {
    channelMap.set(channelId, { seconds, tasks: [] });
  }

  tasks.forEach((task) => {
    const end = task.ended_at ? task.ended_at : periodEnd;
    const clipStart = task.started_at > periodStart ? task.started_at : periodStart;
    const clipEnd = end < periodEnd ? end : periodEnd;
    const seconds = Math.max(0, (clipEnd.getTime() - clipStart.getTime()) / 1000);
    if (seconds <= 0) return;
    const entry = channelMap.get(task.channel_id);
    if (entry) {
      entry.tasks.push(task);
    }
  });

  const channels = Array.from(channelMap.entries())
    .map(([channel_id, data]) => ({
      channel_id,
      seconds: data.seconds,
      tasks: data.tasks
        .sort((a, b) => a.started_at.getTime() - b.started_at.getTime())
        .map((task) => ({
          thread_ts: task.thread_ts,
          started_at: task.started_at.toISOString(),
          ended_at: task.ended_at ? task.ended_at.toISOString() : null
        }))
    }))
    .sort((a, b) => b.seconds - a.seconds);

  const message: SlackReplyMessage = {
    kind: "aggregation_report",
    slack_user_id: slackUserId,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    trigger,
    gross_seconds: grossSeconds,
    other_seconds: otherSeconds,
    break_seconds: breakSeconds,
    channels
  };

  await sendReply(message);
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    await handleRecord(record);
  }
};
