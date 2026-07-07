# Lambda execution role. The permissions boundary (created in bootstrap,
# admin-only-mutable) is what lets the CI role manage this role safely: IAM
# only allows CI's CreateRole/PutRolePolicy when this boundary is attached.

resource "aws_iam_role" "exec" {
  name                 = "${local.name}-role"
  permissions_boundary = "arn:aws:iam::${local.account_id}:policy/aadl-sg-app-boundary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "basic_execution" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Port of the policy infra/mkenv.ts used to generate.
resource "aws_iam_role_policy" "app_access" {
  name = "app-access"
  role = aws_iam_role.exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Anthropic only: cross-region inference profiles resolve to regional
        # foundation models, so both ARN shapes are required.
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:${local.account_id}:inference-profile/us.anthropic.*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.sessions.arn}/sessions/*"
      },
      {
        # Cold-start secret fetch (src/app/secrets.ts). No kms:Decrypt needed:
        # the aws/ssm managed key's policy already allows account principals
        # to decrypt via the SSM service.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/aadl-sg/*"
      },
      {
        Effect = "Allow"
        Action = ["appconfig:StartConfigurationSession", "appconfig:GetLatestConfiguration"]
        Resource = join("", [
          "arn:aws:appconfig:${var.region}:${local.account_id}:",
          "application/${aws_appconfig_application.flags.id}",
          "/environment/${aws_appconfig_environment.flags.environment_id}",
          "/configuration/${aws_appconfig_configuration_profile.flags.configuration_profile_id}",
        ])
      },
    ]
  })
}
