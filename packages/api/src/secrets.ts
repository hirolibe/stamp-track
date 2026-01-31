import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

const applySecretJson = (secretString: string) => {
  let parsed: Record<string, string> = {};
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key] && typeof value === "string") {
      process.env[key] = value;
    }
  }
};

const fetchSecret = async (arn: string) => {
  const res = await client.send(
    new GetSecretValueCommand({
      SecretId: arn
    })
  );
  if (res.SecretString) {
    applySecretJson(res.SecretString);
  }
};

export const ensureSecrets = async () => {
  const appArn = process.env.APP_SECRETS_ARN;
  const slackArn = process.env.SLACK_SECRETS_ARN;
  const dbArn = process.env.DATABASE_SECRETS_ARN;

  if (appArn) {
    await fetchSecret(appArn);
    return;
  }

  if (slackArn) {
    await fetchSecret(slackArn);
  }

  if (dbArn) {
    await fetchSecret(dbArn);
  }
};
