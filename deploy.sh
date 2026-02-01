#!/bin/sh

# delete whole artifact repo (you will need to redeploy to auto create a new one)
gcloud artifacts repositories delete gae-standard --location=europe-west2

# then redeploy with no-cache...
gcloud app deploy .app-prod.yaml --no-cache

