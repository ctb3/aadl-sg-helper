# Secrets come from SSM at deploy time and land in the Lambda env — the
# runtime contract (APP_PIN, GCP_SA_KEY_JSON, ...) is unchanged from mkenv.ts.
# Note: the decrypted values do end up in the TF state file; the state bucket
# is private, encrypted, and admin/CI-only — accepted for this project.

data "aws_ssm_parameter" "app_pin" {
  name = "/aadl-sg/app-pin"
}

data "aws_ssm_parameter" "gcp_sa_key" {
  name = "/aadl-sg/gcp-sa-key"
}

locals {
  lambda_env = {
    APP_PIN             = data.aws_ssm_parameter.app_pin.value
    SESSIONS_BUCKET     = aws_s3_bucket.sessions.bucket
    GCP_SA_KEY_JSON     = data.aws_ssm_parameter.gcp_sa_key.value
    CLAUDE_READER_MODEL = var.claude_reader_model
    CLAUDE_THINKING     = var.claude_thinking
  }
}

resource "aws_lambda_function" "app" {
  function_name = local.name
  package_type  = "Image"
  image_uri     = var.image_uri
  role          = aws_iam_role.exec.arn
  architectures = ["x86_64"]
  timeout       = 120
  memory_size   = 2048

  environment {
    variables = local.lambda_env
  }

  lifecycle {
    # Port of mkenv.ts's guard: Lambda rejects env payloads over 4KB. If the
    # GCP key ever pushes past it, move GCP_SA_KEY_JSON to a runtime SSM fetch.
    precondition {
      condition     = length(jsonencode(local.lambda_env)) <= 4096
      error_message = "Lambda environment exceeds the 4096-byte limit — move GCP_SA_KEY_JSON out of the env."
    }
  }

  depends_on = [aws_iam_role_policy.app_access, aws_iam_role_policy_attachment.basic_execution]
}

resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
}

# The PIN check inside the server is the real gate; the URL is public.
# InvokeFunctionUrl alone still 403'd in the old account — the URL front-end
# also wanted a plain public lambda:InvokeFunction grant. Keeping both.
resource "aws_lambda_permission" "public_url" {
  statement_id           = "public-url"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "public_invoke" {
  statement_id  = "public-invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "*"
}
