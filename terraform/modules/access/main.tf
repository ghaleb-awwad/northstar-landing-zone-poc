# IAM Identity Center permission set assignments (group => permission set) for the account.
# Simulated: written to access.json.

terraform {
  required_providers {
    local = { source = "hashicorp/local" }
  }
}

variable "estate_dir" { type = string }
variable "account_id" { type = string }
variable "access" { type = map(string) }

resource "local_file" "access" {
  filename = "${var.estate_dir}/accounts/${var.account_id}/access.json"
  content  = jsonencode(merge(var.access, { account_id = var.account_id }))
}
