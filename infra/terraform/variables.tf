variable "aws_region" {
  type    = string
  default = "ap-northeast-1"
}

variable "project_name" {
  type    = string
  default = "stamp-track"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.20.10.0/24", "10.20.11.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.20.20.0/24", "10.20.21.0/24"]
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-northeast-1a", "ap-northeast-1c"]
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_name" {
  type    = string
  default = "stamp_track"
}

variable "db_username" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "slack_bot_token" {
  type      = string
  sensitive = true
}

variable "slack_signing_secret" {
  type      = string
  sensitive = true
}

variable "allowed_slack_user_ids" {
  type        = string
  description = "Comma-separated Slack user IDs allowed for user_change/reaction tracking. Empty = allow all."
  default     = ""
}

variable "events_handler_path" {
  type        = string
  description = "Path to built events handler JS file"
  default     = "../../packages/api/dist/lambda/events"
}

variable "events_worker_path" {
  type        = string
  description = "Path to built events worker directory"
  default     = "../../packages/api/dist/lambda/events-worker"
}

variable "worker_handler_path" {
  type        = string
  description = "Path to built worker handler JS file"
  default     = "../../packages/api/dist/lambda/worker"
}

variable "slack_notifier_path" {
  type        = string
  description = "Path to built slack notifier directory"
  default     = "../../packages/api/dist/lambda/slack-notifier"
}
