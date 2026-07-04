# The role GitHub Actions assumes via OIDC. Modeled on the old
# infra/deploy-user-policy.json: everything name-scoped to this app's
# resources, no long-lived credentials anywhere.
#
# The exec-role escalation hole is closed with a permissions boundary: CI may
# create/modify role aadl-sg-app-role ONLY while it carries the
# aadl-sg-app-boundary policy, and the boundary caps what the role can ever do
# regardless of its inline policies. The boundary itself is admin-only — CI has
# no permissions on managed policies. The CI role's own name deliberately does
# not match aadl-sg-app-*, so it cannot modify itself.

resource "aws_iam_policy" "app_boundary" {
  name        = "aadl-sg-app-boundary"
  description = "Permissions boundary for the aadl-sg-app Lambda exec role; caps anything CI-managed."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = "*"
      },
      {
        Sid      = "SessionObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::aadl-sg-sessions-*/sessions/*"
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
    ]
  })
}

data "aws_iam_policy_document" "ci_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for ref in var.github_ref_patterns : "repo:${var.github_repo}:ref:${ref}"]
    }
  }
}

resource "aws_iam_role" "ci" {
  name               = "aadl-sg-ci"
  assume_role_policy = data.aws_iam_policy_document.ci_trust.json
}

resource "aws_iam_role_policy" "ci" {
  name = "deploy"
  role = aws_iam_role.ci.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TfStateList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.tf_state.arn
      },
      {
        # DeleteObject is for the native S3 lockfiles, not for state pruning.
        Sid      = "TfStateObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.tf_state.arn}/aadl-sg/*"
      },
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPushPull"
        Effect = "Allow"
        Action = [
          "ecr:DescribeImages",
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Sid    = "AppFunction"
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:ListVersionsByFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetPolicy",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:CreateFunctionUrlConfig",
          "lambda:GetFunctionUrlConfig",
          "lambda:UpdateFunctionUrlConfig",
          "lambda:DeleteFunctionUrlConfig",
          "lambda:TagResource",
          "lambda:UntagResource",
          "lambda:ListTags",
        ]
        Resource = "arn:aws:lambda:${var.region}:${local.account_id}:function:aadl-sg-app"
      },
      {
        Sid    = "ExecRoleManage"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
        ]
        Resource = "arn:aws:iam::${local.account_id}:role/aadl-sg-app-role"
      },
      {
        Sid    = "ExecRoleWriteBounded"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:PutRolePolicy",
          "iam:AttachRolePolicy",
        ]
        Resource = "arn:aws:iam::${local.account_id}:role/aadl-sg-app-role"
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.app_boundary.arn }
        }
      },
      {
        Sid      = "PassExecRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = "arn:aws:iam::${local.account_id}:role/aadl-sg-app-role"
        Condition = {
          StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" }
        }
      },
      {
        # Bucket-level only (object access belongs to the exec role). Get* is
        # broad because terraform refresh reads a dozen bucket sub-configs.
        # Deliberately NO s3:DeleteBucket — belt and suspenders with the
        # prevent_destroy lifecycle on the bucket.
        Sid    = "SessionsBucketConfig"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:ListBucket",
          "s3:Get*",
          "s3:PutBucketCORS",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketTagging",
          "s3:PutBucketVersioning",
          "s3:PutEncryptionConfiguration",
        ]
        Resource = "arn:aws:s3:::aadl-sg-sessions-*"
      },
      {
        # Deploy-time secret reads (Lambda env injection + smoke-test PIN).
        Sid      = "SsmParams"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/aadl-sg/*"
      },
    ]
  })
}
