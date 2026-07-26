#!/bin/sh
# gitstub container entrypoint: fcgiwrap (git smart HTTP CGI) + the stub
# provider-API/LLM server + nginx TLS edge, all in one throwaway container.
set -e

mkdir -p /run/nginx
rm -f /run/fcgiwrap.sock

# fcgiwrap runs git-http-backend as the nginx user; the socket must be
# writable by nginx workers.
fcgiwrap -s unix:/run/fcgiwrap.sock &
sleep 0.5
chmod 777 /run/fcgiwrap.sock

node /opt/stub/stub-server.mjs &

nginx -g 'daemon off;'
