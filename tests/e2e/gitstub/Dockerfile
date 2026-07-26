# Throwaway git provider + LLM edge for the e2e smoke suite. One container
# serves:
#   - git smart HTTP over TLS (https://gitstub/e2e-repo.git) backed by a bare
#     repo fixture with one initial commit (README.md + src/index.js)
#   - a GitVerse-shaped provider API (https://api.gitstub, proxied to the
#     stub Node server)
#   - an OpenAI-compatible LLM endpoint (http://gitstub:8081/v1, plain HTTP)
FROM alpine:3.21

RUN apk add --no-cache git nginx fcgiwrap openssl nodejs

# TLS edge: one self-signed cert covering both virtual hosts.
RUN mkdir -p /etc/ssl/gitstub \
  && openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout /etc/ssl/gitstub/gitstub.key \
     -out /etc/ssl/gitstub/gitstub.crt \
     -days 3650 -subj '/CN=gitstub' \
     -addext 'subjectAltName=DNS:gitstub,DNS:api.gitstub'

# Bare-repo fixture: one commit on main, receive-pack enabled so the worker
# can push the task branch back.
RUN git init --bare -b main /srv/git/e2e-repo.git \
  && git clone -q /srv/git/e2e-repo.git /tmp/seed \
  && cd /tmp/seed \
  && git config user.email e2e@example.com && git config user.name e2e \
  && echo '# e2e-repo' > README.md \
  && mkdir src && echo 'console.log("hello from the e2e fixture");' > src/index.js \
  && git add -A && git commit -q -m 'initial commit' \
  && git push -q origin main \
  && cd / && rm -rf /tmp/seed \
  && git -C /srv/git/e2e-repo.git config http.receivepack true \
  && chown -R nginx:nginx /srv/git

COPY nginx.conf /etc/nginx/http.d/default.conf
COPY stub-server.mjs llm-fixture.json /opt/stub/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 443 8081
CMD ["/entrypoint.sh"]
