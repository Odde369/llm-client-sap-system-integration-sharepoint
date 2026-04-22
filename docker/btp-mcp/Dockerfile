FROM node:20-bookworm-slim

# CA certificates needed for BTP CLI TLS (cli.btp.cloud.sap uses DigiCert)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*

# BTP CLI binary — download manually from https://tools.hana.ondemand.com/#cloud-btpcli
# Extract tar.gz and place the 'btp' binary in docker/btp-mcp/btp before building
COPY btp /usr/local/bin/btp
RUN chmod +x /usr/local/bin/btp

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --production

COPY index.js /app/index.js

EXPOSE 4004
CMD ["npm", "start"]
