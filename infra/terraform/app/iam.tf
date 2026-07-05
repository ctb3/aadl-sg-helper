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
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.sessions.arn}/sessions/*"
      },
    ]
  })
}
