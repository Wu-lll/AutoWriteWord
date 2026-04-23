# AutoWriteWord

A web app for generating short stories with OpenAI-compatible APIs.

## Run locally

```powershell
npm install
npm start
```

Open:

- `http://127.0.0.1:3210`

## Deploy to Render

This repo includes `render.yaml` and can be deployed as a Render Web Service.

Quick path:

1. Push this repo to GitHub
2. In Render: `New +` -> `Blueprint`
3. Select this repo and create service

Health check endpoint:

- `/api/health`
