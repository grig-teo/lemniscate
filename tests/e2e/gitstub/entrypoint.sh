#!/bin/sh
# gitstub container entrypoint: fcgiwrap (git smart HTTP CGI) + the stub
# provider-API/LLM server + nginx TLS edge, all in one throwaway container.
set -e

mkdir -p /run/nginx /run/fcgiwrap
chown nginx:nginx /run/fcgiwrap
rm -f /run/fcgiwrap/fcgiwrap.sock

# fcgiwrap runs git-http-backend as the nginx user (matching /srv/git
# ownership — as root, git refuses the repo as "dubious ownership" and the
# CGI 500s); the socket must be writable by nginx workers.
su -s /bin/sh nginx -c 'fcgiwrap -s unix:/run/fcgiwrap/fcgiwrap.sock' &
sleep 0.5
chmod 777 /run/fcgiwrap/fcgiwrap.sock

node /opt/stub/stub-server.mjs &

nginx -g 'daemon off;'
