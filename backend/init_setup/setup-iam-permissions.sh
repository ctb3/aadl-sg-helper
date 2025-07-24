#!/bin/bash

# Script to set up IAM permissions for GitHub Actions user
# Run this script with appropriate AWS credentials

set -e

echo "Setting up IAM permissions for GitHub Actions user..."

# Create the IAM policy
echo "Creating IAM policy..."
aws iam create-policy \
  --policy-name GitHubActionsAADLPolicy \
  --policy-document file://iam-policy.json \
  --description "Policy for GitHub Actions to manage AADL backend deployment" \
  2>/dev/null && echo "Policy created" || echo "Policy already exists"

# Get the policy ARN
POLICY_ARN=$(aws iam list-policies \
  --query 'Policies[?PolicyName==`GitHubActionsAADLPolicy`].Arn' \
  --output text)

echo "Policy ARN: $POLICY_ARN"

# Attach the policy to the GitHub Actions user
echo "Attaching policy to github-actions-aadl user..."
aws iam attach-user-policy \
  --user-name github-actions-aadl \
  --policy-arn "$POLICY_ARN" \
  2>/dev/null && echo "Policy attached successfully" || echo "Policy already attached"

echo "IAM permissions setup completed!"
echo ""
echo "The github-actions-aadl user now has the following permissions:"
echo "- IAM role and instance profile management"
echo "- Elastic Beanstalk full access"
echo "- EC2, Auto Scaling, CloudWatch access"
echo "- S3, SNS, CloudFormation access"
echo "- RDS, SQS, CloudWatch Logs access" 