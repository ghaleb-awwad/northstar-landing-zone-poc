# Account baseline: security services, hardening, tags, logging, backup and budget.
# Simulated: written to baseline.json instead of calling AWS APIs.

terraform {
  required_providers {
    local = { source = "hashicorp/local" }
  }
}

variable "estate_dir" { type = string }
variable "account_id" { type = string }
variable "account_name" { type = string }
variable "environment" { type = string }
variable "settings" { type = any }
variable "setting_sources" { type = map(string) }
variable "security_services" { type = map(bool) }
variable "hardening" { type = map(bool) }
variable "allowed_regions" { type = list(string) }
variable "tags" { type = map(string) }

resource "local_file" "baseline" {
  filename = "${var.estate_dir}/accounts/${var.account_id}/baseline.json"
  content = jsonencode({
    account_id        = var.account_id
    account_name      = var.account_name
    environment       = var.environment
    managed_by        = "landing-zone"
    security_services = var.security_services
    hardening         = var.hardening
    allowed_regions   = var.allowed_regions
    tags              = var.tags
    settings          = var.settings
    setting_sources   = var.setting_sources
    logging           = { retention_days = var.settings.log_retention_days }
    backup            = { enabled = var.settings.backup_required }
    budget            = { limit_usd = var.settings.budget_usd }
  })
}
