import { WebClient } from "@slack/web-api";

let cachedToken = "";
let cachedClient: WebClient | null = null;

const getClient = () => {
  const token = process.env.SLACK_BOT_TOKEN || "";
  if (!cachedClient || token !== cachedToken) {
    cachedToken = token;
    cachedClient = new WebClient(token);
  }
  return cachedClient;
};

export const postThreadReply = async (channel: string, threadTs: string, text: string) => {
  await getClient().chat.postMessage({
    channel,
    thread_ts: threadTs,
    text
  });
};

export const sendDmLink = async (slackUserId: string, permalink: string) => {
  const dm = await getClient().conversations.open({ users: slackUserId });
  const channelId = dm.channel?.id;
  if (!channelId) return null;
  const res = await getClient().chat.postMessage({
    channel: channelId,
    text: permalink
  });
  return { dm_channel_id: channelId, dm_message_ts: res.ts || null };
};

export const getPermalink = async (channel: string, messageTs: string) => {
  const res = await getClient().chat.getPermalink({
    channel,
    message_ts: messageTs
  });
  return res.permalink || "";
};

export const getSlackClient = () => getClient();

export const openDm = async (slackUserId: string) => {
  const dm = await getClient().conversations.open({ users: slackUserId });
  return dm.channel?.id || "";
};

export const postDm = async (channelId: string, blocks: any[], text: string) => {
  await getClient().chat.postMessage({
    channel: channelId,
    blocks,
    text
  });
};

export const addReaction = async (channel: string, timestamp: string, emoji: string) => {
  await getClient().reactions.add({
    channel,
    timestamp,
    name: emoji
  });
};
