#!/bin/bash
# Deploy script - run this after Cloud Build completes. Same shape as
# chomptron's deploy.sh — default compute service account, secrets from
# Secret Manager, plain config via --update-env-vars.
set -e

echo "Deploying spendtron to Cloud Run..."

gcloud run deploy spendtron \
  --image us-central1-docker.pkg.dev/spendtron/spendtron-repo/spendtron:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --update-secrets GITHUB_APP_PRIVATE_KEY=github-app-private-key:latest,DATABASE_URL=database-url:latest,STRIPE_SECRET_KEY=stripe-secret-key:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest \
  --update-env-vars GITHUB_APP_ID=4973136,GITHUB_APP_SLUG=spendtron-app,STRIPE_PRICE_ID=price_1UGW1WBrLbOy8fj4N5Nk1xFc,APP_BASE_URL=https://spendtron.com \
  --quiet

echo "✓ Deployment complete!"
gcloud run services describe spendtron --region us-central1 --format='value(status.url)'
