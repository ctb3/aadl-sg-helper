# Per-env hosted zone for the app's custom domain (aadlcode[-test].ctb3.net),
# delegated from the parent ctb3.net zone, which lives in a separate account
# this repo does not manage. The one-time delegation (an NS record in the
# parent zone pointing at app_zone_name_servers) is manual — see
# infra/README.md. GOTCHA: destroying/recreating this zone assigns a NEW
# name-server set, silently breaking the delegation until the parent NS
# record is updated to match.
#
# The zone lives in bootstrap (not the app stack) so the CI role can be
# scoped to record changes within this one zone.

resource "aws_route53_zone" "app" {
  name = var.app_domain
}
