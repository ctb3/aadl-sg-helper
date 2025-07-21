#!/bin/bash

echo "🚀 Deploying AADL Summer Game OCR Helper to AWS..."

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if user is authenticated
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS CLI is not configured. Please run 'aws configure' first."
    exit 1
fi

echo "✅ AWS CLI is configured"

# Deploy Frontend to Amplify
echo "📦 Deploying Frontend to AWS Amplify..."
echo "   - Domain: aadl.ctb3.net"
echo "   - Build command: npm run build"
echo "   - Output directory: frontend/dist"
echo "   - Environment variable: VITE_API_BASE_URL=https://api.aadl.ctb3.net/api"

# Deploy Backend to ECS
echo "🔧 Deploying Backend to AWS ECS..."
echo "   - Domain: api.aadl.ctb3.net"
echo "   - Container: Node.js with Playwright"
echo "   - Port: 3001"

echo ""
echo "📋 Manual Deployment Steps:"
echo ""
echo "1. Frontend (AWS Amplify):"
echo "   - Go to AWS Amplify Console"
echo "   - Connect your Git repository"
echo "   - Set build settings:"
echo "     - Build command: cd frontend && npm run build"
echo "     - Output directory: frontend/dist"
echo "   - Add environment variable:"
echo "     - VITE_API_BASE_URL=https://api.aadl.ctb3.net/api"
echo "   - Add custom domain: aadl.ctb3.net"
echo ""
echo "2. Backend (AWS ECS):"
echo "   - Create ECS cluster"
echo "   - Build and push Docker image"
echo "   - Create ECS service"
echo "   - Add Application Load Balancer"
echo "   - Configure custom domain: api.aadl.ctb3.net"
echo ""
echo "3. SSL Certificates:"
echo "   - Request certificates in AWS Certificate Manager"
echo "   - Attach to both frontend and backend"
echo ""
echo "🎯 Ready to deploy!" 