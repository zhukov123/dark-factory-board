# TaskBoard: single image with API + UI (API serves UI from wwwroot).
# Binds to 0.0.0.0:PORT so the app is reachable on the host when you run:
#   docker run -p 5173:5173 ... taskboard:latest
# Port is configurable at build time: docker build --build-arg PORT=5173 ...
ARG PORT=5173

# Build UI (Node)
FROM node:20-alpine AS ui
WORKDIR /app/ui
COPY TaskBoard.Ui/package.json TaskBoard.Ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY TaskBoard.Ui/ ./
RUN npm run build

# Build API (.NET) with UI in wwwroot
FROM mcr.microsoft.com/dotnet/sdk:9.0-alpine AS api-build
WORKDIR /app
COPY TaskBoard.Api/ ./TaskBoard.Api/
COPY --from=ui /app/ui/dist ./TaskBoard.Api/wwwroot

WORKDIR /app/TaskBoard.Api
RUN dotnet publish -c Release -o /app/out

# Runtime: API + UI (static files in wwwroot), one process
FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS runtime
ARG PORT=5173
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=api-build /app/out ./

# Bind to all interfaces (0.0.0.0) so the server is reachable from outside the container.
# Publish the port when running: docker run -p 5173:5173 ...
ENV ASPNETCORE_URLS="http://0.0.0.0:${PORT}"
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE ${PORT}

# Use /data for SQLite so a volume can persist the DB
ENV ConnectionStrings__Default="Data Source=/data/taskboard.db"
VOLUME /data

ENTRYPOINT ["./TaskBoard.Api"]