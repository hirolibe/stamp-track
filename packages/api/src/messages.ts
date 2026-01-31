export type SlackReplyMessage =
  | {
      kind: "thread_reply";
      channel_id: string;
      thread_ts: string;
      text: string;
    }
  | {
      kind: "dm_link";
      slack_user_id: string;
      channel_id: string;
      thread_ts: string;
    }
  | {
      kind: "dm_blocks";
      slack_user_id: string;
      text: string;
      blocks: any[];
    }
  | {
      kind: "aggregation_report";
      slack_user_id: string;
      period_start: string;
      period_end: string;
      trigger: string;
      gross_seconds: number;
      other_seconds: number;
      channels: {
        channel_id: string;
        seconds: number;
        tasks: {
          thread_ts: string;
          started_at: string;
          ended_at: string | null;
        }[];
      }[];
    };

export type SlackEventEnvelope = {
  event_id: string;
  event_type: string;
  event: any;
  received_at: string;
};
