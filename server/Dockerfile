# MeshCall push relay – deploy anywhere that runs a container (Render, Fly.io, Railway, Cloud Run…)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY push-server.mjs ./
ENV PORT=8787
EXPOSE 8787
# Provide VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT / ALLOWED_ORIGIN as env vars.
# Set SUBSCRIPTIONS_FILE to a path on a persistent volume to keep subscriptions across restarts.
CMD ["node", "push-server.mjs"]
