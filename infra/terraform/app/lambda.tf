# Secrets stay in SSM until runtime: the env carries parameter NAMES, and the
# app fetches the values at cold start (src/app/secrets.ts). Nothing secret
# lands in the TF state file or in lambda:GetFunctionConfiguration output.

locals {
  lambda_env = {
    APP_PIN_SSM_PARAM    = "/aadl-sg/app-pin"
    GCP_SA_KEY_SSM_PARAM = "/aadl-sg/gcp-sa-key"
    SESSIONS_BUCKET      = aws_s3_bucket.sessions.bucket
    CLAUDE_READER_MODEL  = var.claude_reader_model
    CLAUDE_THINKING      = var.claude_thinking
    # AppConfig identifiers (not secrets) the flag reader polls at runtime.
    APPCONFIG_APP     = aws_appconfig_application.flags.id
    APPCONFIG_ENV     = aws_appconfig_environment.flags.environment_id
    APPCONFIG_PROFILE = aws_appconfig_configuration_profile.flags.configuration_profile_id
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
    # Lambda rejects env payloads over 4KB. Nowhere near it since the secrets
    # moved to a runtime SSM fetch, but the guard is free.
    precondition {
      condition     = length(jsonencode(local.lambda_env)) <= 4096
      error_message = "Lambda environment exceeds the 4096-byte limit."
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
# also wants a lambda:InvokeFunction grant. That grant is scoped with the
# lambda:InvokedViaFunctionUrl=true condition so a bare `aws lambda invoke`
# from a random account stays closed (the 2026-07 security-pass goal). NOTE
# the condition key differs per action: function_url_auth_type
# (lambda:FunctionUrlAuthType) is only accepted on InvokeFunctionUrl —
# putting it on the InvokeFunction grant fails apply with
# InvalidParameterValueException; invoked_via_function_url is the one that
# fits InvokeFunction. Both accounts also carry AWS-managed
# FunctionURLAllowPublicAccess/FunctionURLAllowInvokeAction statements (same
# effect, added by the console outside Terraform) — harmless duplicates.
#
# The depends_on chain serializes these: URL creation and the two
# AddPermission calls all mutate the function, and running them concurrently
# threw ResourceConflictException (409) on prod's first apply.
resource "aws_lambda_permission" "public_url" {
  statement_id           = "public-url"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"

  depends_on = [aws_lambda_function_url.app]
}

resource "aws_lambda_permission" "public_invoke" {
  statement_id             = "public-invoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.app.function_name
  principal                = "*"
  invoked_via_function_url = true

  depends_on = [aws_lambda_permission.public_url]
}
