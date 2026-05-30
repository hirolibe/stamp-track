import { SQSEvent } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ensureSecrets } from "./secrets";
import { postThreadReply, sendDmLink, openDm, postDm, getSlackClient, addReaction } from "./slack";
import { SlackReplyMessage } from "./messages";

const sqsClient = new SQSClient({});
const eventsQueueUrl = process.env.EVENTS_QUEUE_URL || "";

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

const extractTaskTitle = (raw: string): string => {
  const bracketMatch = raw.match(/[【\[](.+?)[】\]]/);
  if (bracketMatch) return bracketMatch[1].trim();
  return truncateText(sanitizeText(raw.split("\n")[0]));
};

const fetchThreadRawText = async (channelId: string, threadTs: string): Promise<string> => {
  const res = await getSlackClient().conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 1
  });
  const message = res.messages?.[0];
  return message?.text || "（メッセージなし）";
};

const handleMessage = async (message: SlackReplyMessage) => {
  if (message.kind === "thread_reply") {
    await postThreadReply(message.channel_id, message.thread_ts, message.text);
    return;
  }

  if (message.kind === "dm_link") {
    // dm_link は現在未使用
    return;
  }

  if (message.kind === "update_dm_info") {
    // Handled by events-worker, skip here
    return;
  }

  if (message.kind === "add_reaction") {
    try {
      await addReaction(message.channel_id, message.message_ts, message.emoji);
      console.log("add_reaction: success", message.channel_id, message.message_ts, message.emoji);
    } catch (err) {
      console.error("add_reaction: failed", err);
    }
    return;
  }

  if (message.kind === "dm_blocks") {
    const channelId = await openDm(message.slack_user_id);
    if (!channelId) return;
    await postDm(channelId, message.blocks, message.text);
  }

  if (message.kind === "dm_text") {
    const channelId = await openDm(message.slack_user_id);
    if (!channelId) return;
    await postDm(channelId, [], message.text);
  }

  if (message.kind === "aggregation_report") {
    const dmChannelId = await openDm(message.slack_user_id);
    if (!dmChannelId) return;

    const periodStart = new Date(message.period_start);
    const headerText = `${formatDateJst(periodStart)}の稼働時間`;

    // 各タスクのメッセージテキストを取得して案件名を抽出
    const projectMap = new Map<string, { seconds: number; tasks: { title: string; seconds: number }[] }>();

    for (const task of message.tasks) {
      const raw = await fetchThreadRawText(task.channel_id, task.thread_ts);
      const match = raw.match(/案件名[：:]\s*(.+)/m);
      const projectName = match ? match[1].trim() : "未分類";
      const title = extractTaskTitle(raw);

      if (!projectMap.has(projectName)) {
        projectMap.set(projectName, { seconds: 0, tasks: [] });
      }
      const entry = projectMap.get(projectName)!;
      entry.seconds += task.seconds;
      entry.tasks.push({ title, seconds: task.seconds });
    }

    const projects = Array.from(projectMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.seconds - a.seconds);

    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "退勤しました！今日も一日おつかれさまでした:hi:"
        }
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: headerText
        }
      }
    ];

    for (const project of projects) {
      const lines: string[] = [];
      lines.push(`*${project.name}*：${formatDuration(project.seconds)}`);
      for (const task of project.tasks) {
        lines.push(`• ${task.title}：${formatDuration(task.seconds)}`);
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
    if (message.break_seconds > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `休憩：${formatDuration(message.break_seconds)}`
        }
      });
    }
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `合計：${formatDuration(message.gross_seconds)}`
      }
    });

    await postDm(dmChannelId, blocks, "集計結果");
  }
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SlackReplyMessage;
    await handleMessage(message);
  }
};
