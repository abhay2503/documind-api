#!/bin/bash
# Runs inside the LocalStack container once it is ready. Idempotent.
set -euo pipefail

REGION=ap-south-1
BUCKET="${DOCUMIND_BUCKET:-documind-documents-local}"
ORIGIN="${DOCUMIND_CORS_ORIGIN:-http://localhost:3000}"
QUEUE=documind-summary-queue-local
DLQ=documind-summary-dlq-local

awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null || \
  awslocal s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"

awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [\"$ORIGIN\"],
    \"AllowedMethods\": [\"PUT\"],
    \"AllowedHeaders\": [\"*\"],
    \"MaxAgeSeconds\": 3000
  }]
}"

DLQ_URL=$(awslocal sqs create-queue --queue-name "$DLQ" --region "$REGION" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name "$QUEUE" --region "$REGION" --attributes "{
  \"VisibilityTimeout\": \"5400\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}" >/dev/null

echo "DocuMind LocalStack resources ready: s3://$BUCKET, $QUEUE (+ $DLQ)"
