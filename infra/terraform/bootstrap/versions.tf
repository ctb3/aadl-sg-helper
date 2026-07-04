# Bootstrap stack — applied by Carl with an SSO admin profile, once per account
# (never by CI). Creates the things CI itself depends on: TF state bucket,
# GitHub OIDC provider, the scoped CI role, and the shared ECR repo.
#
# Chicken-and-egg: the state bucket is created by this very stack, so the FIRST
# apply runs on local state. Then uncomment the backend block below (fill in
# the account id) and run `terraform init -migrate-state`.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # backend "s3" {
  #   bucket       = "aadl-sg-tf-state-<ACCOUNT_ID>"
  #   key          = "aadl-sg/bootstrap.tfstate"
  #   region       = "us-east-2"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}
