# Render Deployment Guide

This project can run on Render Free Web Service.

## 1) Push to GitHub

Run in this project directory:

```powershell
cd "C:\Users\Wu\Desktop\思政实践作业\实践论文-docs\docs\111"
git init
git add .
git commit -m "init novel studio for render"
git branch -M main
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

If the remote already exists, skip `git remote add origin ...`.

## 2) Create service on Render

1. Open Render dashboard.
2. Click `New +` -> `Blueprint`.
3. Select your GitHub repo.
4. Render will detect `render.yaml`.
5. Confirm and create.

## 3) Verify

After deploy success:

- Open `https://<your-service>.onrender.com/api/health`
- Expect JSON with `"ok": true`
- Then open `https://<your-service>.onrender.com`

## 4) Mobile access

Your phone can open the same Render URL directly, no local computer required.

## 5) Notes for free plan

- Free instance sleeps when idle; first request can be slow.
- `runs/` data is ephemeral on free instances and may be cleared on restart/redeploy.
- For long-term history, use external storage (database/object storage).
