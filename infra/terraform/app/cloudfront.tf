# Custom domain (var.app_domain) → CloudFront → the Lambda Function URL.
# The Function URL stays public (auth NONE) and keeps working as a direct
# bypass for debugging. No OAC: SigV4-signing the origin would force
# every browser POST to carry x-amz-content-sha256, which the client doesn't
# send. If the origin ever needs locking down, a secret custom origin header
# checked in server.ts is the cheap option.

resource "aws_acm_certificate" "app" {
  provider = aws.use1

  domain_name       = var.app_domain
  validation_method = "DNS"

  lifecycle {
    # Per provider docs: replace the cert before releasing the old one, or a
    # replacement wrecks the distribution that still references it mid-apply.
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  provider = aws.use1

  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]

  # Default is 75m; if validation isn't done in 15 the delegation from the
  # parent ctb3.net zone is missing/broken — fail the deploy instead of
  # burning runner minutes.
  timeouts {
    create = "15m"
  }
}

resource "aws_cloudfront_distribution" "app" {
  aliases         = [var.app_domain]
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_100"
  comment         = "aadl-sg-app (${var.app_domain})"

  origin {
    # Function URLs route by Host header, so the origin is addressed by its
    # own hostname and the viewer Host must never be forwarded (see the
    # origin_request_policy below).
    domain_name = trimsuffix(trimprefix(aws_lambda_function_url.app.function_url, "https://"), "/")
    origin_id   = "lambda-url"

    custom_origin_config {
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      http_port              = 80
      https_port             = 443

      # 60 is the max without a quota bump. /api/extract (cold start + GCV +
      # tier-2 Bedrock) and /api/submit (sequential aadl.org round-trips per
      # account) can blow past the 30s default. If 504s ever show up on
      # many-account submits, request the "response timeout per origin"
      # quota increase (up to 180s).
      origin_read_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda-url"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS-managed policies, referenced by their global constant IDs — the
    # by-name data sources need un-scopeable List* permissions on the CI role.
    # CachingDisabled: never cache (GET / is no-store anyway; API is dynamic).
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # AllViewerExceptHostHeader: forward everything (query, cookies, headers)
    # EXCEPT Host — a forwarded viewer Host 403s the Function URL.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.app.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "app_alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.zone_id
  name    = var.app_domain
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}
