output "function_url" {
  value = aws_lambda_function_url.app.function_url
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "sessions_bucket" {
  value = aws_s3_bucket.sessions.bucket
}
