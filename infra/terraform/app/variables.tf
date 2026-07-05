variable "region" {
  type    = string
  default = "us-east-2"
}

variable "image_uri" {
  description = "Full ECR image URI (immutable tag) built and pushed by the workflow."
  type        = string
}

variable "app_domain" {
  description = "This env's custom domain (CloudFront alias in front of the Function URL)."
  type        = string
}

variable "zone_id" {
  description = "Hosted zone for app_domain — created by the bootstrap stack (output app_zone_id)."
  type        = string
}

# Non-secret runtime config, previously in .env — now reviewable in PRs.
variable "claude_reader_model" {
  description = "Bedrock model id for tier-2 reads. Needs a per-account Marketplace subscription."
  type        = string
}

variable "claude_thinking" {
  type    = string
  default = "disabled"
}
