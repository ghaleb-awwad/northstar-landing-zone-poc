# Organization root: OU tree, one SCP per OU (with exception exemptions) and account placement.
# Simulated: written to organization.json instead of AWS Organizations.

terraform {
  required_version = ">= 1.5"
  required_providers {
    local = { source = "hashicorp/local", version = "~> 2.5" }
  }
  backend "local" {
    path = "../../.lz/state/organization.tfstate"
  }
}

variable "config_dir" { type = string }
variable "estate_dir" { type = string }

locals {
  org        = yamldecode(file("${var.config_dir}/organization.yaml"))
  global     = yamldecode(file("${var.config_dir}/global.yaml"))
  exceptions = yamldecode(file("${var.config_dir}/exceptions.yaml")).exceptions
  envs       = { for f in fileset("${var.config_dir}/environments", "*.yaml") : trimsuffix(f, ".yaml") => yamldecode(file("${var.config_dir}/environments/${f}")) }
  accounts   = { for f in fileset("${var.config_dir}/accounts", "*.yaml") : trimsuffix(f, ".yaml") => yamldecode(file("${var.config_dir}/accounts/${f}")) }

  active_exceptions = [for e in local.exceptions : e if timecmp(plantimestamp(), "${e.expires}T23:59:59Z") <= 0 && try(e.scp_statement, null) != null]
  exemptions = {
    for s in distinct([for e in local.active_exceptions : e.scp_statement]) :
    s => [for e in local.active_exceptions : local.accounts[e.account].account_id if e.scp_statement == s]
  }
}

module "scp" {
  source   = "../modules/scp"
  for_each = { for name, ou in local.org.ous : name => tolist(ou.scp) if length(ou.scp) > 0 }

  statements      = each.value
  allowed_regions = local.global.allowed_regions
  exemptions      = local.exemptions
}

resource "local_file" "organization" {
  filename = "${var.estate_dir}/organization.json"
  content = jsonencode({
    ous        = { for name, ou in local.org.ous : name => { parent = try(ou.parent, null), scp = ou.scp } }
    policies   = { for name, m in module.scp : name => jsondecode(m.document) }
    exemptions = local.exemptions
    accounts = merge(
      { for a in local.org.core_accounts : a.name => { id = a.id, ou = a.ou, type = "core" } },
      { for name, a in local.accounts : name => { id = a.account_id, ou = local.envs[a.environment].ou, type = "workload" } }
    )
  })
}
