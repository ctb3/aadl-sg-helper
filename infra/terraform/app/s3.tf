# Private sessions bucket: every field session logs photo/crop/results/
# verdicts under sessions/v<version>/ for future labeling. Data is precious —
# prevent_destroy here AND the CI role has no s3:DeleteBucket.

resource "aws_s3_bucket" "sessions" {
  bucket = local.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "sessions" {
  bucket                  = aws_s3_bucket.sessions.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# Explicit SSE (S3 would default to this anyway; explicit beats implicit for
# a bucket of user photos).
resource "aws_s3_bucket_server_side_encryption_configuration" "sessions" {
  bucket = aws_s3_bucket.sessions.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Belt and suspenders: every access path today is HTTPS (the SDK); this keeps
# it that way.
resource "aws_s3_bucket_policy" "sessions" {
  bucket = aws_s3_bucket.sessions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.sessions.arn, "${aws_s3_bucket.sessions.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.sessions]
}
