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
  const grossSeconds = Math.max(0, (periodEnd.getTime() - periodStart.getTime()) / 1000);
  const taskSeconds = clipped.reduce((a, b) => a + b.seconds, 0);
  const breakSeconds = computeBreakDurations(breaks, periodStart, periodEnd);
  const otherSeconds = Math.max(0, grossSeconds - taskSeconds - breakSeconds);

  const flatTasks = clipped
    .map((c, i) => {
      const task = tasks[i];
      return {
        channel_id: task.channel_id,
        thread_ts: task.thread_ts,
        seconds: c.seconds,
        started_at: task.started_at.toISOString(),
        ended_at: task.ended_at ? task.ended_at.toISOString() : null
      };
    })
    .filter((t) => t.seconds > 0)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));

  const message: SlackReplyMessage = {
    kind: "aggregation_report",
    slack_user_id: slackUserId,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    trigger,
    gross_seconds: grossSeconds,
    other_seconds: otherSeconds,
    break_seconds: breakSeconds,
    tasks: flatTasks
  };

  await sendReply(message);
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    await handleRecord(record);
  }
};
