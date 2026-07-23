import crypto from "crypto";
import { SQSEvent } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getPrisma } from "./db";
import { ensureSecrets } from "./secrets";
import { getMessageText } from "./slack";
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

const isBreakStatus = (emoji: string | undefined) => emoji === ":kyukei_chu:";
const isCheckoutStatus = (emoji: string | undefined) => emoji === ":taikin_zumi:";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const SCHEDULE_PATTERN = /スケジュール\s*[:：]\s*(\d{1,2}):(\d{2})\s*[〜~\-～ー]\s*(\d{1,2}):(\d{2})/;

const buildJstDate = (base: Date, hour: number, minute: number) => {
  const jst = new Date(base.getTime() + JST_OFFSET_MS);
  const utcMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour, minute) - JST_OFFSET_MS;
  return new Date(utcMs);
};

const parseScheduleRange = (text: string, base: Date) => {
  const match = text.match(SCHEDULE_PATTERN);
  if (!match) return null;

  const [, startHour, startMinute, endHour, endMinute] = match;
  const start = buildJstDate(base, Number(startHour), Number(startMinute));
  const end = buildJstDate(base, Number(endHour), Number(endMinute));
  if (end <= start) return null;

  return { start, end };
};

const isUserAllowed = (slackUserId: string | undefined) => {
  if (!slackUserId) return false;
  if (allowedSlackUserIds.size === 0) return false;
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

  if (reaction === "task_start") {
    const openWork = await prisma.workSession.findFirst({
      where: { user_id: user.id, clock_out_at: null }
    });

    if (!openWork) {
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `現在は勤務時間外です。出勤後に:task_start:を押してください。`
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
        text: `すでにタスクの実行が開始されています！`
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
        text: `他のタスクを実行中です！再開するには:task_start:を押し直してください！🙇`
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
      text: `タスクの実行を開始しました！:hi:`
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

    const messageText = channelId.startsWith("D") ? "" : await getMessageText(channelId, threadTs);
    const schedule = parseScheduleRange(messageText, new Date());

    if (active) {
      console.log("task_end: active=", JSON.stringify(active));
      await prisma.taskSession.update({
        where: { id: active.id },
        data: schedule
          ? { started_at: schedule.start, ended_at: schedule.end }
          : { ended_at: new Date() }
      });
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `タスクが完了しました！🎉`
      });
      if (active.dm_channel_id && active.dm_message_ts) {
        console.log("task_end: sending add_reaction to queue");
        await sendReply({
          kind: "add_reaction",
          channel_id: active.dm_channel_id,
          message_ts: active.dm_message_ts,
          emoji: "task_end"
        });
      } else {
        console.log("task_end: no dm_channel_id or dm_message_ts", active.dm_channel_id, active.dm_message_ts);
      }
    } else if (schedule) {
      console.log("task_end: no active session, creating from schedule", schedule);
      await prisma.taskSession.create({
        data: {
          user_id: user.id,
          channel_id: channelId,
          thread_ts: threadTs,
          started_at: schedule.start,
          ended_at: schedule.end
        }
      });
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `タスクが完了しました！🎉`
      });
    } else {
      await sendReply({
        kind: "thread_reply",
        channel_id: channelId,
        thread_ts: threadTs,
        text: `まだタスクの実行が開始されていません！`
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
  const isBreak = isBreakStatus(statusEmoji);
  const isCheckout = isCheckoutStatus(statusEmoji);

  const dbUser = await ensureUser(prisma, slackUserId);

  const openWork = await prisma.workSession.findFirst({
    where: { user_id: dbUser.id, clock_out_at: null },
    orderBy: { clock_in_at: "desc" }
  });

  const openBreak = await prisma.breakSession.findFirst({
    where: { user_id: dbUser.id, ended_at: null },
    orderBy: { started_at: "desc" }
  });

  // Case 1: Changing TO break status (not from checkout)
  if (isBreak) {
    // If no open work session, ignore
    if (!openWork) return;

    // If already on break, ignore
    if (openBreak) return;

    // Start a new break session
    await prisma.breakSession.create({
      data: { user_id: dbUser.id, started_at: new Date() }
    });

    // End active tasks during break
    const activeTasks = await prisma.taskSession.findMany({
      where: { user_id: dbUser.id, ended_at: null }
    });
    if (activeTasks.length > 0) {
      await prisma.taskSession.updateMany({
        where: { user_id: dbUser.id, ended_at: null },
        data: { ended_at: new Date() }
      });
      await Promise.all(
        activeTasks.map((task) =>
          sendReply({
            kind: "thread_reply",
            channel_id: task.channel_id,
            thread_ts: task.thread_ts,
            text: `休憩に入ったため、実行中のタスクを終了しました。再開するには:task_start:を押し直してください！🙇`
          })
        )
      );
    }
    return;
  }

  // Case 2: Changing TO checkout status
  if (isCheckout) {
    if (!openWork) return;

    // Close any open break session
    if (openBreak) {
      await prisma.breakSession.update({
        where: { id: openBreak.id },
        data: { ended_at: new Date() }
      });
    }

    // Close work session
    const closedWork = await prisma.workSession.update({
      where: { id: openWork.id },
      data: { clock_out_at: new Date() }
    });

    // End active tasks
    const activeTasks = await prisma.taskSession.findMany({
      where: { user_id: dbUser.id, ended_at: null }
    });
    if (activeTasks.length > 0) {
      await prisma.taskSession.updateMany({
        where: { user_id: dbUser.id, ended_at: null },
        data: { ended_at: new Date() }
      });
    }

    // Trigger aggregation
    if (aggregationQueueUrl) {
      const messageBody = JSON.stringify({
        user_id: dbUser.id,
        slack_user_id: slackUserId,
        period_start: closedWork.clock_in_at,
        period_end: closedWork.clock_out_at,
        trigger: "checkout"
      });
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: aggregationQueueUrl,
          MessageBody: messageBody
        })
      );
    }
    return;
  }

  // Case 3: Changing FROM break to working status (not checkout)
  if (openBreak) {
    await prisma.breakSession.update({
      where: { id: openBreak.id },
      data: { ended_at: new Date() }
    });
  }

  // Case 4: Starting work (no open session)
  if (!openWork) {
    await prisma.workSession.create({
      data: { user_id: dbUser.id, clock_in_at: new Date() }
    });
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

type UpdateDmInfoMessage = {
  kind: "update_dm_info";
  task_session_id: string;
  dm_channel_id: string;
  dm_message_ts: string;
};

const handleUpdateDmInfo = async (message: UpdateDmInfoMessage) => {
  const prisma = getPrisma();
  await prisma.taskSession.update({
    where: { id: message.task_session_id },
    data: {
      dm_channel_id: message.dm_channel_id,
      dm_message_ts: message.dm_message_ts
    }
  });
  console.log("update_dm_info: DB updated for task_session_id=", message.task_session_id);
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    if (body.kind === "update_dm_info") {
      await handleUpdateDmInfo(body as UpdateDmInfoMessage);
    } else {
      await handleEnvelope(body as SlackEventEnvelope);
    }
  }
};
