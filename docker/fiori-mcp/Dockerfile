FROM node:20-alpine
RUN apk add --no-cache ca-certificates
RUN npm install -g mcp-proxy@latest @sap-ux/fiori-mcp-server
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r//' /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 3211
ENTRYPOINT ["/entrypoint.sh"]
