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

const formatDateShortJst = (date: Date) =>
  date.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short"
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

const extractProjectName = (raw: string): string => {
  const match = raw.match(/案件名[：:]\s*(.+)/m);
  return match ? match[1].trim() : "その他";
};

type ThreadInfo = { text: string; completed: boolean };

const fetchThreadInfo = async (
  cache: Map<string, ThreadInfo>,
  channelId: string,
  threadTs: string
): Promise<ThreadInfo> => {
  const key = `${channelId}:${threadTs}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const res = await getSlackClient().conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 1
  });
  const message = res.messages?.[0];
  const text = message?.text || "（メッセージなし）";
  const completed = (message?.reactions || []).some((r: any) => r.name === "task_end");
  const info: ThreadInfo = { text, completed };
  cache.set(key, info);
  return info;
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
    const dateLabel = formatDateShortJst(periodStart);
    const threadInfoCache = new Map<string, ThreadInfo>();

    // 案件別の稼働時間（セッション単位で合算）と、チェックリスト用のユニークスレッド一覧を集計
    const projectMap = new Map<string, { seconds: number; tasks: { title: string; seconds: number }[] }>();
    const threadEntries = new Map<string, { projectName: string; title: string; completed: boolean; startedAt: string }>();

    for (const task of message.tasks) {
      const info = await fetchThreadInfo(threadInfoCache, task.channel_id, task.thread_ts);
      const projectName = extractProjectName(info.text);
      const title = extractTaskTitle(info.text);

      if (!projectMap.has(projectName)) {
        projectMap.set(projectName, { seconds: 0, tasks: [] });
      }
      const entry = projectMap.get(projectName)!;
      entry.seconds += task.seconds;
      entry.tasks.push({ title, seconds: task.seconds });

      const threadKey = `${task.channel_id}:${task.thread_ts}`;
      const existing = threadEntries.get(threadKey);
      if (!existing || task.started_at < existing.startedAt) {
        threadEntries.set(threadKey, {
          projectName,
          title,
          completed: info.completed,
          startedAt: task.started_at
        });
      }
    }

    const projects = Array.from(projectMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.seconds - a.seconds);

    // 夕方の振り返り: ユニークスレッドを稼働時間側と同じ案件順にグルーピング
    const reflectionByProject = new Map<string, { title: string; completed: boolean; startedAt: string }[]>();
    for (const entry of threadEntries.values()) {
      if (!reflectionByProject.has(entry.projectName)) {
        reflectionByProject.set(entry.projectName, []);
      }
      reflectionByProject.get(entry.projectName)!.push(entry);
    }
    for (const tasks of reflectionByProject.values()) {
      tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }

    const reflectionBlocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `【${dateLabel} 夕方の振り返り】`
        }
      }
    ];

    for (const project of projects) {
      const tasks = reflectionByProject.get(project.name);
      if (!tasks || tasks.length === 0) continue;
      const lines = [`◯ ${project.name}`];
      for (const task of tasks) {
        lines.push(`[${task.completed ? "✓" : "　"}] ${task.title}`);
      }
      reflectionBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n")
        }
      });
    }

    await postDm(dmChannelId, reflectionBlocks, "夕方の振り返り");

    const durationBlocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `【${dateLabel} 稼働時間】`
        }
      }
    ];

    for (const project of projects) {
      const lines = [`◯${project.name}：${formatDuration(project.seconds)}`];
      for (const task of project.tasks) {
        lines.push(`- ${task.title}：${formatDuration(task.seconds)}`);
      }
      durationBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n")
        }
      });
    }

    durationBlocks.push({ type: "divider" });
    const summaryLines = [`その他：${formatDuration(message.other_seconds)}`];
    if (message.break_seconds > 0) {
      summaryLines.push(`休憩：${formatDuration(message.break_seconds)}`);
    }
    summaryLines.push(`合計：${formatDuration(message.gross_seconds)}`);
    durationBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: summaryLines.join("\n")
      }
    });
    durationBlocks.push({ type: "divider" });

    await postDm(dmChannelId, durationBlocks, "稼働時間");
  }
};

export const handler = async (event: SQSEvent) => {
  await ensureSecrets();
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SlackReplyMessage;
    await handleMessage(message);
  }
};
