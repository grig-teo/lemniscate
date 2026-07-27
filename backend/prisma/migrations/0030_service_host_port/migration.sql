-- Per-service VPS host port: each VPS-deployed service publishes on its own
-- host port (docker -p left side) so two apps with the same container port
-- (e.g. both defaulting to 80) don't collide on the host. Null for lemniscate
-- services (Traefik routes by container name, not host port).

ALTER TABLE "Service" ADD COLUMN "hostPort" INTEGER;
