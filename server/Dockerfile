FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=8080
ENV AUDIVERIS_PATH=/opt/audiveris/bin/Audiveris
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true"
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/4/tessdata

# Install Tesseract OCR + unzip (required by Audiveris)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-osd \
    unzip \
    curl \
    libfreetype6 \
    libfontconfig1 \
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

# Audiveris writes cache/config to user home
ENV HOME=/tmp/audiveris-home
RUN mkdir -p /tmp/audiveris-home

EXPOSE 8080
CMD ["node", "server.js"]
