#!/bin/bash
set -e

PROJECT_ID="your-gcp-project-id"   # ← change this
REGION="us-central1"
REPO="gcr.io/$PROJECT_ID"

echo "=== Building backend (Audiveris + Node.js) ==="
cd server
# Copy Audiveris into build context
cp -r /opt/audiveris ./audiveris
docker build -t $REPO/music-server:latest .
rm -rf ./audiveris
docker push $REPO/music-server:latest

echo "=== Deploying backend to Cloud Run ==="
gcloud run deploy music-server \
  --image $REPO/music-server:latest \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 4Gi \
  --cpu 2 \
  --timeout 120 \
  --port 8080 \
  --execution-environment gen2

echo "=== Building frontend ==="
cd ..
docker build -t $REPO/music-frontend:latest .
docker push $REPO/music-frontend:latest

echo "=== Deploying frontend to Cloud Run ==="
gcloud run deploy music-frontend \
  --image $REPO/music-frontend:latest \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 256Mi \
  --cpu 1 \
  --port 8080

echo ""
echo "=== Done! ==="
echo "Get your service URLs with:"
echo "  gcloud run services list --region $REGION"
