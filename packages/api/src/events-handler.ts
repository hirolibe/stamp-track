import crypto from "crypto";
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getPrisma } from "./db";
import { getPermalink, postThreadReply, sendDmLink } from "./slack";
import { computeSlackSignature, verifySlackSignature } from "./slack-signature";
import { ensureSecrets } from "./secrets";

const aggregationQueueUrl = process.env.AGGREGATION_QUEUE_URL || "";

const sqsClient = new SQSClient({});

const jsonResponse = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const textResponse = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "text/plain" },
  body
});

const getRawBody = (event: APIGatewayProxyEventV2) => {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
};

const hashPayload = (payload: string) =>
  crypto.createHash("sha256").update(payload, "utf8").digest("hex");

const isOutStatus = (emoji: string | undefined) =>
  emoji === ":kyukei_chu:" || emoji === ":taikin_zumi:";

export const handler = async (event: APIGatewayProxyEventV2) => {
  await ensureSecrets();

  const rawBody = getRawBody(event);
  const signature = event.headers["x-slack-signature"] || event.headers["X-Slack-Signature"];
  const timestamp =
    event.headers["x-slack-request-timestamp"] ||
    event.headers["X-Slack-Request-Timestamp"];

  const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    if (timestamp && signingSecret) {
      const expected = computeSlackSignature(rawBody, timestamp, signingSecret);
      console.log("slack_signature_mismatch", {
        timestamp,
        signature,
        expected_prefix: expected.slice(0, 12),
        signature_prefix: signature?.slice(0, 12) || "",
        body_length: rawBody.length,
        is_base64: event.isBase64Encoded || false
      });
    } else {
      console.log("slack_signature_missing", {
        has_timestamp: Boolean(timestamp),
        has_signature: Boolean(signature),
        has_secret: Boolean(signingSecret)
      });
    }
    return textResponse(401, "invalid signature");
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return textResponse(400, "invalid json");
  }

  if (payload.type === "url_verification") {
    return jsonResponse(200, { challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return textResponse(200, "ok");
  }

  const prisma = getPrisma();
  const eventId: string | undefined = payload.event_id;
  const eventType: string | undefined = payload.event?.type;

  if (!eventId || !eventType) {
    return textResponse(200, "ok");
  }

  const payloadHash = hashPayload(rawBody);
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
      return textResponse(200, "duplicate");
    }
    throw error;
  }

  if (eventType === "reaction_added") {
    await handleReactionAdded(prisma, payload.event);
  }

  if (eventType === "user_change") {
    await handleUserChange(prisma, payload.event);
  }

  return textResponse(200, "ok");
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
  if (reaction !== "start" && reaction !== "end") return;

  const slackUserId = event?.user;
  const channelId = event?.item?.channel;
  const threadTs = event?.item?.ts;
  if (!slackUserId || !channelId || !threadTs) return;

  const user = await ensureUser(prisma, slackUserId);

  if (reaction === "start") {
    const openWork = await prisma.workSession.findFirst({
      where: { user_id: user.id, clock_out_at: null }
    });

    if (!openWork) {
      await postThreadReply(
        channelId,
        threadTs,
        "現在は勤務時間外です。出勤後に:start:を押してください。"
      );
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
      await postThreadReply(channelId, threadTs, "すでにタスクの実行が開始されています！");
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
      await postThreadReply(
        otherActive.channel_id,
        otherActive.thread_ts,
        "他のタスクを実行中です！再開するには:start:を押し直してください！🙇"
      );
    }

    await prisma.taskSession.create({
      data: {
        user_id: user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        started_at: new Date()
      }
    });

    await postThreadReply(channelId, threadTs, "タスクの実行を開始しました！:hi:");

    const permalink = await getPermalink(channelId, threadTs);
    if (permalink) {
      await sendDmLink(slackUserId, permalink);
    }
  }

  if (reaction === "end") {
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
      await postThreadReply(channelId, threadTs, "タスクが完了しました！🎉");
    } else {
      await postThreadReply(channelId, threadTs, "まだタスクの実行が開始されていません！");
    }
  }
};

const handleUserChange = async (prisma: ReturnType<typeof getPrisma>, event: any) => {
  const user = event?.user;
  const slackUserId = user?.id;
  if (!slackUserId) return;

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
