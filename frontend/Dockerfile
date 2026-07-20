# ---------- build: compile the Vite app ----------
FROM node:22-alpine AS build
WORKDIR /app
# Bake-time configuration (subpath deploys set these via compose build args)
ARG VITE_BASE_PATH=/
ARG VITE_API_URL=
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- runtime: serve static files via nginx ----------
FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
