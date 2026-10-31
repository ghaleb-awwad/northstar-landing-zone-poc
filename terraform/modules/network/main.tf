# Account VPC carved from the environment's IPAM-style pool, attached to the environment's TGW route table.
# Simulated: written to network.json.

terraform {
  required_providers {
    local = { source = "hashicorp/local" }
  }
}

variable "estate_dir" { type = string }
variable "account_id" { type = string }
variable "cidr_pool" { type = string }
variable "allow_public_ip" { type = bool }
variable "tgw_route_table" { type = string }
variable "tgw_owner_id" {
  description = "Core account that owns the shared Transit Gateway (shared via AWS RAM)."
  type        = string
}

variable "network_index" {
  type = number
  validation {
    condition     = var.network_index >= 1 && var.network_index <= 255
    error_message = "network_index must be between 1 and 255."
  }
}

resource "local_file" "network" {
  filename = "${var.estate_dir}/accounts/${var.account_id}/network.json"
  content = jsonencode({
    account_id      = var.account_id
    vpc_cidr        = cidrsubnet(var.cidr_pool, 8, var.network_index)
    public_subnets  = var.allow_public_ip
    tgw_route_table = var.tgw_route_table
    tgw_owner       = var.tgw_owner_id
  })
}
