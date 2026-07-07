FROM node:20-alpine

# ffmpeg is used at runtime to transcode uploaded WAV audio to MP3.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY backend/ ./
COPY shared/ ../shared/

EXPOSE 3001

CMD ["npm", "run", "dev"]
