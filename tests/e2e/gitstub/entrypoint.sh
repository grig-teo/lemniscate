#!/bin/sh
# gitstub container entrypoint: the mock-LLM server + the nginx TLS edge in
# front of Gitea, all in one throwaway container.
set -e

mkdir -p /run/nginx

node /opt/stub/stub-server.mjs &

nginx -g 'daemon off;'
