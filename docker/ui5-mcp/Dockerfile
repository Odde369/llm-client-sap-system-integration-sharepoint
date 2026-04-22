FROM node:20-alpine
RUN apk add --no-cache ca-certificates
RUN npm install -g mcp-proxy@latest @ui5/mcp-server
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r//' /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 3210
ENTRYPOINT ["/entrypoint.sh"]
