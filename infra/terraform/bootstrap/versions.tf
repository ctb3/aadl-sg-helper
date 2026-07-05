# Bootstrap stack — applied by Carl with an SSO admin profile, once per account
# (never by CI). Creates the things CI itself depends on: TF state bucket,
# GitHub OIDC provider, the scoped CI role, and the shared ECR repo.
#
# The backend is partial on purpose: the bucket is per-account, so every init
# names it explicitly (forgetting the flag fails loudly instead of writing to
# the wrong account):
#   terraform init -backend-config="bucket=aadl-sg-tf-state-<ACCOUNT_ID>" \
#                  -backend-config="region=us-east-2"
# Add -reconfigure when switching this working dir between accounts.
# First-ever apply in a fresh account: create the bucket with the CLI, init
# against it, `terraform import aws_s3_bucket.tf_state <bucket>`, then apply
# (see infra/README.md).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    key          = "aadl-sg/bootstrap.tfstate"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}
