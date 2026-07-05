# Direct Function URL — kept as a debugging bypass; the app's real address
# is app_url.
output "function_url" {
  value = aws_lambda_function_url.app.function_url
}

# No trailing slash — apitest builds "$URL/api/...".
output "app_url" {
  value = "https://${var.app_domain}"
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "sessions_bucket" {
  value = aws_s3_bucket.sessions.bucket
}
