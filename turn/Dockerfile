FROM coturn/coturn:4.6-alpine
USER root
RUN apk add --no-cache bind-tools
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
