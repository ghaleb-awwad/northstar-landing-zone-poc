# Account root: applied once per account, each in its own workspace (= its own state).
# Merges global -> environment -> account configuration and calls the baseline modules.

terraform {
  required_version = ">= 1.5"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    workspace_dir = "../../.lz/state/accounts"
  }
}

variable "config_dir" { type = string }
variable "estate_dir" { type = string }
variable "account_name" { type = string }

locals {
  global     = yamldecode(file("${var.config_dir}/global.yaml"))
  account    = yamldecode(file("${var.config_dir}/accounts/${var.account_name}.yaml"))
  env        = yamldecode(file("${var.config_dir}/environments/${local.account.environment}.yaml"))
  exceptions = yamldecode(file("${var.config_dir}/exceptions.yaml")).exceptions
  overrides  = try(local.account.overrides, {})

  settings = merge(local.global.defaults, local.env.settings, local.overrides)
  sources = { for k in keys(local.settings) : k => (
    contains(keys(local.overrides), k) ? "account" :
    contains(keys(local.env.settings), k) ? "environment" : "global"
  ) }

  has_public_ip_exception = anytrue([
    for e in local.exceptions : e.account == var.account_name && e.rule == "PRD-01" &&
    timecmp(plantimestamp(), "${e.expires}T23:59:59Z") <= 0
  ])
}

# Terraform-native guardrails, checked on every plan.
resource "terraform_data" "guardrails" {
  lifecycle {
    precondition {
      condition     = terraform.workspace == var.account_name
      error_message = "Workspace does not match the account. Refusing to apply."
    }
    precondition {
      condition     = !(local.account.environment == "prod" && local.settings.allow_public_ip) || local.has_public_ip_exception
      error_message = "Public IPs in Production require an approved, unexpired exception."
    }
  }
}

module "baseline" {
  source            = "../modules/account-baseline"
  estate_dir        = var.estate_dir
  account_id        = local.account.account_id
  account_name      = var.account_name
  environment       = local.account.environment
  settings          = local.settings
  setting_sources   = local.sources
  security_services = local.global.security_services
  hardening         = local.global.hardening
  allowed_regions   = local.global.allowed_regions
  tags = {
    Environment  = local.account.environment
    Owner        = local.account.owner
    CostCenter   = local.account.cost_center
    BusinessUnit = local.account.business_unit
    ManagedBy    = "landing-zone"
  }
}

module "network" {
  source          = "../modules/network"
  estate_dir      = var.estate_dir
  account_id      = local.account.account_id
  cidr_pool       = local.env.network.cidr_pool
  network_index   = local.account.network_index
  allow_public_ip = local.settings.allow_public_ip
  tgw_route_table = local.env.network.tgw_route_table
}

module "access" {
  source     = "../modules/access"
  estate_dir = var.estate_dir
  account_id = local.account.account_id
  access     = local.env.access
}
