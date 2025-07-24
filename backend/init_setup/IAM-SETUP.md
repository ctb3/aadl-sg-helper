# IAM Permissions Setup for GitHub Actions

This document explains how to set up the necessary IAM permissions for the GitHub Actions user to deploy the AADL backend to Elastic Beanstalk.

## Problem

The GitHub Actions user `github-actions-aadl` needs additional IAM permissions to:
- Create and manage IAM roles and instance profiles
- List and verify IAM resources
- Deploy to Elastic Beanstalk

## Solution

### Step 1: Run the Setup Script

Execute the setup script with appropriate AWS credentials:

```bash
cd backend
chmod +x setup-iam-permissions.sh
./setup-iam-permissions.sh
```

### Step 2: Verify Permissions

The script will:
1. Create a custom IAM policy `GitHubActionsAADLPolicy`
2. Attach the policy to the `github-actions-aadl` user
3. Grant all necessary permissions for deployment

### Step 3: Required Permissions

The policy includes permissions for:

#### IAM Management
- `iam:CreateRole`, `iam:DeleteRole`, `iam:GetRole`, `iam:ListRoles`
- `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:ListAttachedRolePolicies`
- `iam:CreateInstanceProfile`, `iam:DeleteInstanceProfile`, `iam:GetInstanceProfile`, `iam:ListInstanceProfiles`
- `iam:AddRoleToInstanceProfile`, `iam:RemoveRoleFromInstanceProfile`
- `iam:PassRole`

#### Elastic Beanstalk
- `elasticbeanstalk:*` - Full access to Elastic Beanstalk

#### Supporting Services
- `ec2:*` - EC2 instance management
- `autoscaling:*` - Auto Scaling groups
- `cloudwatch:*` - Monitoring and metrics
- `s3:*` - S3 bucket access
- `sns:*` - Simple Notification Service
- `cloudformation:*` - CloudFormation stacks
- `rds:*` - Relational Database Service
- `sqs:*` - Simple Queue Service
- `logs:*` - CloudWatch Logs

## Manual Setup (Alternative)

If you prefer to set up permissions manually:

1. **Create the IAM Policy:**
   ```bash
   aws iam create-policy \
     --policy-name GitHubActionsAADLPolicy \
     --policy-document file://iam-policy.json
   ```

2. **Attach to User:**
   ```bash
   aws iam attach-user-policy \
     --user-name github-actions-aadl \
     --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/GitHubActionsAADLPolicy
   ```

## Verification

After setup, the GitHub Actions workflow should be able to:
- Create IAM roles and instance profiles
- List and verify IAM resources
- Deploy to Elastic Beanstalk without permission errors

## Security Notes

- The policy is scoped to specific resources where possible
- Only the `aws-elasticbeanstalk-ec2-role` and its instance profile are accessible
- Consider further restricting permissions based on your security requirements 