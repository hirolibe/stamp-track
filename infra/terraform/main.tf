terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name = var.project_name
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = "${local.name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = {
    Name = "${local.name}-igw"
  }
}

resource "aws_vpc_endpoint" "sqs" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.sqs"
  vpc_endpoint_type = "Interface"
  subnet_ids        = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids = [aws_security_group.vpc_endpoint.id]
  private_dns_enabled = true
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type = "Interface"
  subnet_ids        = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids = [aws_security_group.vpc_endpoint.id]
  private_dns_enabled = true
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[0]
  availability_zone       = var.availability_zones[0]
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.name}-public-a"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[1]
  availability_zone       = var.availability_zones[1]
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.name}-public-b"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[0]
  availability_zone = var.availability_zones[0]
  tags = {
    Name = "${local.name}-private-a"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[1]
  availability_zone = var.availability_zones[1]
  tags = {
    Name = "${local.name}-private-b"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = {
    Name = "${local.name}-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}


resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags = {
    Name = "${local.name}-private-rt"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "lambda" {
  name        = "${local.name}-lambda-sg"
  description = "Lambda security group"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "vpc_endpoint" {
  name        = "${local.name}-vpce-sg"
  description = "VPC endpoint security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}


resource "aws_security_group" "db" {
  name        = "${local.name}-db-sg"
  description = "RDS security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnet"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_db_instance" "main" {
  identifier              = "${local.name}-db"
  engine                  = "postgres"
  engine_version          = "17.7"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  db_name                 = var.db_name
  username                = var.db_username
  password                = var.db_password
  db_subnet_group_name     = aws_db_subnet_group.main.name
  vpc_security_group_ids   = [aws_security_group.db.id]
  publicly_accessible      = false
  skip_final_snapshot      = true
  deletion_protection      = false
  backup_retention_period  = 1
  multi_az                 = false
  apply_immediately        = true
}

resource "aws_sqs_queue" "aggregation" {
  name                      = "${local.name}-aggregation-queue"
  visibility_timeout_seconds = 60
}

resource "aws_sqs_queue" "events" {
  name                      = "${local.name}-events-queue"
  visibility_timeout_seconds = 60
}

resource "aws_sqs_queue" "slack_reply" {
  name                      = "${local.name}-slack-reply-queue"
  visibility_timeout_seconds = 60
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}


resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_extra" {
  name = "${local.name}-lambda-extra"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [
          aws_sqs_queue.aggregation.arn,
          aws_sqs_queue.events.arn,
          aws_sqs_queue.slack_reply.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [aws_secretsmanager_secret.app.arn]
      }
    ]
  })
}

resource "aws_secretsmanager_secret" "app" {
  name = "${local.name}-app-secrets"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL        = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.address}:5432/${var.db_name}"
    SLACK_BOT_TOKEN     = var.slack_bot_token
    SLACK_SIGNING_SECRET = var.slack_signing_secret
  })
}

data "archive_file" "events" {
  type        = "zip"
  source_dir  = var.events_handler_path
  output_path = "${path.module}/dist/events-handler.zip"
}

data "archive_file" "events_worker" {
  type        = "zip"
  source_dir  = var.events_worker_path
  output_path = "${path.module}/dist/events-worker.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = var.worker_handler_path
  output_path = "${path.module}/dist/aggregation-worker.zip"
}

data "archive_file" "slack_notifier" {
  type        = "zip"
  source_dir  = var.slack_notifier_path
  output_path = "${path.module}/dist/slack-notifier.zip"
}

data "archive_file" "migration_runner" {
  type        = "zip"
  source_dir  = var.migration_runner_path
  output_path = "${path.module}/dist/migration-runner.zip"
}

resource "aws_lambda_function" "events" {
  function_name = "${local.name}-events"
  role          = aws_iam_role.lambda.arn
  handler       = "events-handler.handler"
  runtime       = "nodejs20.x"
  filename      = data.archive_file.events.output_path
  source_code_hash = data.archive_file.events.output_base64sha256
  timeout       = 15

  environment {
    variables = {
      APP_SECRETS_ARN          = aws_secretsmanager_secret.app.arn
      EVENTS_QUEUE_URL         = aws_sqs_queue.events.id
    }
  }
}

resource "aws_lambda_function" "events_worker" {
  function_name = "${local.name}-events-worker"
  role          = aws_iam_role.lambda.arn
  handler       = "events-worker.handler"
  runtime       = "nodejs20.x"
  filename      = data.archive_file.events_worker.output_path
  source_code_hash = data.archive_file.events_worker.output_base64sha256
  timeout       = 20

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      APP_SECRETS_ARN          = aws_secretsmanager_secret.app.arn
      AGGREGATION_QUEUE_URL    = aws_sqs_queue.aggregation.id
      SLACK_REPLY_QUEUE_URL    = aws_sqs_queue.slack_reply.id
      ALLOWED_SLACK_USER_IDS   = var.allowed_slack_user_ids
    }
  }
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.name}-worker"
  role          = aws_iam_role.lambda.arn
  handler       = "aggregation-worker.handler"
  runtime       = "nodejs20.x"
  filename      = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  timeout       = 30

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      APP_SECRETS_ARN = aws_secretsmanager_secret.app.arn
      SLACK_REPLY_QUEUE_URL = aws_sqs_queue.slack_reply.id
    }
  }
}

resource "aws_lambda_function" "slack_notifier" {
  function_name = "${local.name}-slack-notifier"
  role          = aws_iam_role.lambda.arn
  handler       = "slack-notifier.handler"
  runtime       = "nodejs20.x"
  filename      = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256
  timeout       = 15

  environment {
    variables = {
      APP_SECRETS_ARN   = aws_secretsmanager_secret.app.arn
      EVENTS_QUEUE_URL  = aws_sqs_queue.events.id
    }
  }
}

resource "aws_lambda_function" "migration_runner" {
  function_name = "${local.name}-migration-runner"
  role          = aws_iam_role.lambda.arn
  handler       = "migration-runner.handler"
  runtime       = "nodejs20.x"
  filename      = data.archive_file.migration_runner.output_path
  source_code_hash = data.archive_file.migration_runner.output_base64sha256
  timeout       = 60

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      APP_SECRETS_ARN = aws_secretsmanager_secret.app.arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "worker_sqs" {
  event_source_arn = aws_sqs_queue.aggregation.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 10
}

resource "aws_lambda_event_source_mapping" "events_worker_sqs" {
  event_source_arn = aws_sqs_queue.events.arn
  function_name    = aws_lambda_function.events_worker.arn
  batch_size       = 10
}

resource "aws_lambda_event_source_mapping" "slack_reply_sqs" {
  event_source_arn = aws_sqs_queue.slack_reply.arn
  function_name    = aws_lambda_function.slack_notifier.arn
  batch_size       = 10
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "events" {
  api_id           = aws_apigatewayv2_api.http.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.events.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "events" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /slack/events"
  target    = "integrations/${aws_apigatewayv2_integration.events.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.events.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
