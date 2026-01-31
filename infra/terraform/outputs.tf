output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "aggregation_queue_url" {
  value = aws_sqs_queue.aggregation.id
}

output "events_queue_url" {
  value = aws_sqs_queue.events.id
}

output "slack_reply_queue_url" {
  value = aws_sqs_queue.slack_reply.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "app_secrets_arn" {
  value = aws_secretsmanager_secret.app.arn
}
