# Shared image repo. IMMUTABLE tags: every deployable image is a unique tag
# (test-N.A-g<sha> or vX.Y.Z) — no :latest, rollback = repoint to an old tag.

resource "aws_ecr_repository" "app" {
  name                 = "aadl-sg-app"
  image_tag_mutability = "IMMUTABLE"
}

# Lambda (the service) pulls the image itself; the repo policy must allow it.
# Replaces the sed-templated infra/ecr-repo-policy.json.
resource "aws_ecr_repository_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LambdaECRImageRetrieval"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Condition = {
          StringLike = {
            "aws:sourceArn" = "arn:aws:lambda:${var.region}:${local.account_id}:function:aadl-sg-app"
          }
        }
      },
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  # v* release tags match no rule and are kept forever.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "keep only the last 15 test builds"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["test-"]
          countType     = "imageCountMoreThan"
          countNumber   = 15
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "expire untagged layers after a week"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
    ]
  })
}
