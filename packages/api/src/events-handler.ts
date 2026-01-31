import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { verifySlackSignature } from "./slack-signature";
import { ensureSecrets } from "./secrets";
import { SlackEventEnvelope } from "./messages";

const eventsQueueUrl = process.env.EVENTS_QUEUE_URL || "";
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

export const handler = async (event: APIGatewayProxyEventV2) => {
  await ensureSecrets();

  const rawBody = getRawBody(event);
  const signature = event.headers["x-slack-signature"] || event.headers["X-Slack-Signature"];
  const timestamp =
    event.headers["x-slack-request-timestamp"] ||
    event.headers["X-Slack-Request-Timestamp"];

  const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
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

  const eventId: string | undefined = payload.event_id;
  const eventType: string | undefined = payload.event?.type;

  if (!eventId || !eventType) {
    return textResponse(200, "ok");
  }

  if (!eventsQueueUrl) {
    return textResponse(500, "events queue not configured");
  }

  const envelope: SlackEventEnvelope = {
    event_id: eventId,
    event_type: eventType,
    event: payload.event,
    received_at: new Date().toISOString()
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: eventsQueueUrl,
      MessageBody: JSON.stringify(envelope)
    })
  );

  return textResponse(200, "ok");
};
