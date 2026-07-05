variable "region" {
  type    = string
  default = "us-east-2"
}

variable "github_repo" {
  description = "GitHub repo (owner/name) allowed to assume the CI role via OIDC."
  type        = string
  default     = "ctb3/aadl-sg-helper"
}

variable "github_sub_patterns" {
  description = <<-EOT
    OIDC sub-claim suffixes (StringLike, after "repo:<repo>:") allowed to
    assume the CI role. This is the env separation: the test account trusts
    only its patterns, prod only its own — a main push cannot reach prod.
    GOTCHA: jobs that declare `environment: <name>` get sub
    "repo:<repo>:environment:<name>" INSTEAD of "...:ref:refs/...", so the
    deploy jobs match on the environment form; the ref forms are kept for
    any future jobs without an environment.
  EOT
  type        = list(string)
}
