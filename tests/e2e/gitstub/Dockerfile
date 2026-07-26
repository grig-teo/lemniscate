# TLS edge + mock LLM for the e2e suite. One container serves:
#   - the TLS edge in front of the Gitea container (https://gitstub for web +
#     git smart HTTP, https://api.gitstub for the /api/v1 REST API)
#   - the mock OpenAI-compatible LLM endpoint (http://gitstub:8081/v1, plain
#     HTTP; scenario router in llm-router.mjs)
FROM alpine:3.21

RUN apk add --no-cache nginx openssl nodejs

# TLS edge: one self-signed cert covering both virtual hosts.
RUN mkdir -p /etc/ssl/gitstub \
  && openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout /etc/ssl/gitstub/gitstub.key \
     -out /etc/ssl/gitstub/gitstub.crt \
     -days 3650 -subj '/CN=gitstub' \
     -addext 'subjectAltName=DNS:gitstub,DNS:api.gitstub'

COPY nginx.conf /etc/nginx/http.d/default.conf
COPY stub-server.mjs llm-router.mjs llm-fixture.json /opt/stub/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 443 8081
CMD ["/entrypoint.sh"]
