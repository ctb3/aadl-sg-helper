# Test account (825555019530): main-branch pushes deploy here.
# environment:test = the sub GitHub actually sends for deploy-test.yml's job
# (it declares `environment: test`); the ref form covers non-environment jobs.
app_domain = "aadlcode-test.ctb3.net"

github_sub_patterns = [
  "environment:test",
  "ref:refs/heads/main",
]
