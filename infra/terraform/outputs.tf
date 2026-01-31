output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "aggregation_queue_url" {
  value = aws_sqs_queue.aggregation.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "app_secrets_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "ssm_instance_id" {
  value = aws_instance.ssm.id
}
