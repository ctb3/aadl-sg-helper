# Runtime feature flags (AWS AppConfig). Terraform seeds the flags ON and does
# the initial deployment; flips thereafter happen OUT OF BAND — AppConfig
# console, or `create-hosted-configuration-version` + `start-deployment` (see
# infra/README.md) — and are preserved by the ignore_changes below. The Lambda
# reads these at runtime via appconfigdata (src/app/flags.ts), so a toggle needs
# no redeploy. Each account has its own application → test/prod toggle
# independently.

resource "aws_appconfig_application" "flags" {
  name = "aadl-sg"
}

resource "aws_appconfig_environment" "flags" {
  name           = var.env_name
  application_id = aws_appconfig_application.flags.id
}

resource "aws_appconfig_configuration_profile" "flags" {
  application_id = aws_appconfig_application.flags.id
  name           = "flags"
  location_uri   = "hosted"
  type           = "AWS.AppConfig.FeatureFlags"
}

resource "aws_appconfig_hosted_configuration_version" "flags" {
  application_id           = aws_appconfig_application.flags.id
  configuration_profile_id = aws_appconfig_configuration_profile.flags.configuration_profile_id
  content_type             = "application/json"

  content = jsonencode({
    version = "1"
    flags = {
      "store-images" = {
        name        = "store-images"
        description = "Persist the session photo/crop to S3. Telemetry JSON is kept regardless."
      }
    }
    values = {
      "store-images" = { enabled = true }
    }
  })

  # Flips create new versions out-of-band; don't let `apply` revert them.
  lifecycle {
    ignore_changes = [content]
  }
}

# A simple boolean flag has no alarms to bake against, and the predefined
# AppConfig.AllAtOnce carries a 10-minute bake window that locks the environment
# between flips. This custom strategy deploys at 100% with zero bake, so flips
# are instant and immediately re-flippable.
resource "aws_appconfig_deployment_strategy" "flip" {
  name                           = "aadl-sg-flip"
  description                    = "Instant flag flips: 100% at once, no bake window."
  deployment_duration_in_minutes = 0
  final_bake_time_in_minutes     = 0
  growth_factor                  = 100
  growth_type                    = "LINEAR"
  replicate_to                   = "NONE"
}

resource "aws_appconfig_deployment" "flags" {
  application_id           = aws_appconfig_application.flags.id
  environment_id           = aws_appconfig_environment.flags.environment_id
  configuration_profile_id = aws_appconfig_configuration_profile.flags.configuration_profile_id
  configuration_version    = aws_appconfig_hosted_configuration_version.flags.version_number
  deployment_strategy_id   = aws_appconfig_deployment_strategy.flip.id
  description              = "Seed deployment (store-images ON). Later flips deploy out-of-band."

  # Out-of-band flips deploy newer versions; keep TF from redeploying the seed.
  lifecycle {
    ignore_changes = [configuration_version]
  }
}
