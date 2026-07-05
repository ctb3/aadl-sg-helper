# Prod account (766253192238): only vX.Y.Z releases deploy here.
# environment:prod = the sub GitHub actually sends for deploy-prod.yml's job
# (it declares `environment: prod`); the ref form covers non-environment jobs.
app_domain = "aadlcode.ctb3.net"

github_sub_patterns = [
  "environment:prod",
  "ref:refs/tags/v*",
]
