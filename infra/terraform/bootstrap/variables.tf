variable "region" {
  type    = string
  default = "us-east-2"
}

variable "github_repo" {
  description = "GitHub repo (owner/name) allowed to assume the CI role via OIDC."
  type        = string
  default     = "ctb3/aadl-sg-helper"
}

variable "github_ref_patterns" {
  description = <<-EOT
    Git refs (StringLike patterns) allowed to assume the CI role. This is the
    env separation: the test account trusts only refs/heads/main, the prod
    account only refs/tags/v* — a main push cannot reach prod.
  EOT
  type        = list(string)
}
