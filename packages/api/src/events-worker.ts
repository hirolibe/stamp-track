import crypto from "crypto";
import { SQSEvent } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getPrisma } from "./db";
import { ensureSecrets } from "./secrets";
import { SlackEventEnvelope, SlackReplyMessage } from "./messages";

const replyQueueUrl = process.env.SLACK_REPLY_QUEUE_URL || "";
const aggregationQueueUrl = process.env.AGGREGATION_QUEUE_URL || "";
const allowedSlackUserIds = new Set(
  (process.env.ALLOWED_SLACK_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const sqsClient = new SQSClient({});

const hashPayload = (payload: string) =>
  crypto.createHash("sha256").update(payload, "utf8").digest("hex");

const isOutStatus = (emoji: string | undefined) =>
  emoji === ":kyukei_chu:" || emoji === ":taikin_zumi:";

const isUserAllowed = (slackUserId: string | undefined) => {
  if (!slackUserId) return false;
  if (allowedSlackUserIds.size === 0) return true;
  return allowedSlackUserIds.has(slackUserId);
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

const ensureUser = async (prisma: ReturnType<typeof getPrisma>, slackUserId: string) => {
  return prisma.user.upsert({
    where: { slack_user_id: slackUserId },
    create: { slack_user_id: slackUserId },
    update: {}
  });
};

const handleReactionAdded = async (prisma: ReturnType<typeof getPrisma>, event: any) => {
  const reaction = event?.reaction;
  if (reaction !== "task_start" && reaction !== "task_end") return;

  const slackUserId = event?.user;
  const channelId = event?.item?.channel;
  const threadTs = event?.item?.ts;
  if (!slackUserId || !channelId || !threadTs) return;
  if (!isUserAllowed(slackUserId)) return;

  const user = await ensureUser(prisma, slackUserId);
  const actor = `<@${slackUserId}>`;

  if (reaction === "task_start") {
    const openWork = await prisma.workSession.findFirst({
      where: { user_id: user.id, clock_out_at: null }
    });

    if (!openWork) {
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `${actor} 現在は勤務時間外です。出勤後に:task_start:を押してください。`
      });
      return;
    }

    const sameThreadActive = await prisma.taskSession.findFirst({
      where: {
        user_id: user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        ended_at: null
      }
    });

    if (sameThreadActive) {
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `${actor} すでにタスクの実行が開始されています！`
      });
      return;
    }

    const otherActive = await prisma.taskSession.findFirst({
      where: {
        user_id: user.id,
        ended_at: null,
        NOT: {
          channel_id: channelId,
          thread_ts: threadTs
        }
      }
    });

    if (otherActive) {
      await prisma.taskSession.update({
        where: { id: otherActive.id },
        data: { ended_at: new Date() }
      });
      await sendReply({
        kind: "thread_reply",
        channel_id: otherActive.channel_id,
        thread_ts: otherActive.thread_ts,
        text: `${actor} 他のタスクを実行中です！再開するには:task_start:を押し直してください！🙇`
      });
    }

    await prisma.taskSession.create({
      data: {
        user_id: user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        started_at: new Date()
      }
    });

    await sendReply({
      kind: "thread_reply",
      channel_id: channelId,
      thread_ts: threadTs,
      text: `${actor} タスクの実行を開始しました！:hi:`
    });

    await sendReply({
      kind: "dm_link",
      slack_user_id: slackUserId,
      channel_id: channelId,
      thread_ts: threadTs
    });
  }

  if (reaction === "task_end") {
    const active = await prisma.taskSession.findFirst({
      where: {
        user_id: user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        ended_at: null
      }
    });

    if (active) {
      await prisma.taskSession.update({
        where: { id: active.id },
        data: { ended_at: new Date() }
      });
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `${actor} タスクが完了しました！🎉`
      });
    } else {
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `${actor} まだタスクの実行が開始されていません！`
      });
    }
  }
};

const handleUserChange = async (prisma: ReturnType<typeof getPrisma>, event: any) => {
  const user = event?.user;
  const slackUserId = user?.id;
  if (!slackUserId) return;
  if (!isUserAllowed(slackUserId)) return;

  const statusEmoji = user?.profile?.status_emoji;
  const isOut = isOutStatus(statusEmoji);

  const dbUser = await ensureUser(prisma, slackUserId);

  const openWork = await prisma.workSession.findFirst({
    where: { user_id: dbUser.id, clock_out_at: null },
    orderBy: { clock_in_at: "desc" }
  });

  if (!isOut) {
    if (!openWork) {
      await prisma.workSession.create({
        data: { user_id: dbUser.id, clock_in_at: new Date() }
      });
    }
    return;
  }

  if (!openWork) return;

  const closedWork = await prisma.workSession.update({
    where: { id: openWork.id },
    data: { clock_out_at: new Date() }
  });

  const activeTasks = await prisma.taskSession.findMany({
    where: { user_id: dbUser.id, ended_at: null }
  });

  if (activeTasks.length > 0) {
    await prisma.taskSession.updateMany({
      where: { user_id: dbUser.id, ended_at: null },
      data: { ended_at: new Date() }
    });
  }

  if (aggregationQueueUrl) {
    const trigger = statusEmoji === ":kyukei_chu:" ? "break" : "checkout";
    const messageBody = JSON.stringify({
      user_id: dbUser.id,
      slack_user_id: slackUserId,
      period_start: closedWork.clock_in_at,
      period_end: closedWork.clock_out_at,
      trigger
    });
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: aggregationQueueUrl,
        MessageBody: messageBody
      })
    );
  }
};

const handleEnvelope = async (envelope: SlackEventEnvelope) => {
  const prisma = getPrisma();
  const eventId = envelope.event_id;
  const eventType = envelope.event_type;

  const payloadHash = hashPayload(JSON.stringify(envelope.event));
  try {
    await prisma.slackEvent.create({
      data: {
        event_id: eventId,
        event_type: eventType,
        payload_hash: payloadHash
      }
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return;
    }
    throw error;
  }

  if (eventType === "reaction_added") {
    await handleReactionAdded(prisma, envelope.event);
  }

  if (eventType === "user_change") {
    await handleUserChange(prisma, envelope.event);
  }
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    const envelope = JSON.parse(record.body) as SlackEventEnvelope;
    await handleEnvelope(envelope);
  }
};
