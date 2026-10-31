# Builds one SCP document for an OU from statement templates.
# Governance exceptions are compiled in as an aws:PrincipalAccount condition.

variable "statements" {
  description = "Statement template names (statements/<name>.json.tftpl)."
  type        = list(string)
}

variable "allowed_regions" {
  type = list(string)
}

variable "exemptions" {
  description = "Statement name => account IDs exempted by an active governance exception."
  type        = map(list(string))
  default     = {}
}

locals {
  document = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for s in var.statements : jsondecode(templatefile("${path.module}/statements/${s}.json.tftpl", {
        allowed_regions = var.allowed_regions
        exempt_accounts = lookup(var.exemptions, s, [])
      }))
    ]
  })
}

output "document" {
  value = local.document

  precondition {
    condition     = length(local.document) <= 5120
    error_message = "SCP exceeds the AWS 5,120 character limit."
  }
}
