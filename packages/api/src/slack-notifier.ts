import { SQSEvent } from "aws-lambda";
import { ensureSecrets } from "./secrets";
import { getPermalink, postThreadReply, sendDmLink, openDm, postDm, getSlackClient } from "./slack";
import { SlackReplyMessage } from "./messages";

const formatDuration = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours === 0) return `${minutes}分`;
  return `${hours}時間${minutes}分`;
};

const formatDateJst = (date: Date) =>
  date.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

const sanitizeText = (text: string) =>
  text.replace(/\s+/g, " ").trim();

const truncateText = (text: string, max = 80) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const fetchThreadTitle = async (channelId: string, threadTs: string) => {
  const res = await getSlackClient().conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 1
  });
  const message = res.messages?.[0];
  if (!message) return "（メッセージなし）";
  const raw = message.text || "（メッセージなし）";
  return truncateText(sanitizeText(raw));
};

const handleMessage = async (message: SlackReplyMessage) => {
  if (message.kind === "thread_reply") {
    await postThreadReply(message.channel_id, message.thread_ts, message.text);
    return;
  }

  if (message.kind === "dm_link") {
    const permalink = await getPermalink(message.channel_id, message.thread_ts);
    if (permalink) {
      await sendDmLink(message.slack_user_id, permalink);
    }
    return;
  }

  if (message.kind === "dm_blocks") {
    const channelId = await openDm(message.slack_user_id);
    if (!channelId) return;
    await postDm(channelId, message.blocks, message.text);
  }

  if (message.kind === "aggregation_report") {
    const channelId = await openDm(message.slack_user_id);
    if (!channelId) return;

    const periodStart = new Date(message.period_start);
    const periodEnd = new Date(message.period_end);
    const headerText = `${formatDateJst(periodStart)}の稼働時間`;

    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: headerText
        }
      }
    ];

    for (const channel of message.channels) {
      const lines: string[] = [];
      lines.push(`<#${channel.channel_id}>：${formatDuration(channel.seconds)}`);
      for (const task of channel.tasks) {
        const permalink = await getPermalink(channel.channel_id, task.thread_ts);
        const title = await fetchThreadTitle(channel.channel_id, task.thread_ts);
        if (permalink) {
          lines.push(`• <${permalink}|${title}>`);
        } else {
          lines.push(`• ${title}`);
        }
      }
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n")
        }
      });
    }

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `その他：${formatDuration(message.other_seconds)}`
      }
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `合計：${formatDuration(message.gross_seconds)}`
      }
    });

    await postDm(channelId, blocks, "集計結果");
  }
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SlackReplyMessage;
    await handleMessage(message);
  }
};
