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

# The client uploads the full-res JPEG straight to S3 via a presigned PUT
# (dodges the 6MB Function URL cap). Port of infra/s3-cors.json.
resource "aws_s3_bucket_cors_configuration" "sessions" {
  bucket = aws_s3_bucket.sessions.id

  cors_rule {
    allowed_origins = ["*"]
    allowed_methods = ["PUT"]
    allowed_headers = ["content-type"]
    max_age_seconds = 3600
  }
}
