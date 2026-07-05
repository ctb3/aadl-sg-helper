output "ci_role_arn" {
  description = "Set as the GitHub environment variable AWS_ROLE_ARN."
  value       = aws_iam_role.ci.arn
}

output "state_bucket" {
  description = "Set as the GitHub environment variable TF_STATE_BUCKET."
  value       = aws_s3_bucket.tf_state.bucket
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}
