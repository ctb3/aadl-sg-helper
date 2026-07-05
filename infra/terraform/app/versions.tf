# App stack — applied by CI (deploy-test.yml / deploy-prod.yml) with the
# aadl-sg-ci role. Same code in both accounts; only the backend bucket,
# tfvars file, and image_uri differ per run.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # bucket + region arrive via -backend-config (per account).
  backend "s3" {
    key          = "aadl-sg/app.tfstate"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  name       = "aadl-sg-app"
  bucket     = "aadl-sg-sessions-${local.account_id}"
}
