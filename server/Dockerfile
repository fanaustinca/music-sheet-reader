FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=8080
ENV AUDIVERIS_PATH=/opt/audiveris/bin/Audiveris

# Install Tesseract OCR + unzip (required by Audiveris)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    unzip \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy Audiveris (bundled JRE included)
COPY audiveris/ /opt/audiveris/
RUN chmod +x /opt/audiveris/bin/Audiveris

# Copy server code
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js parse-musicxml.js ./

EXPOSE 8080
CMD ["node", "server.js"]
