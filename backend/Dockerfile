FROM node:20-alpine

# Install FFmpeg, build tools for whisper.cpp, git, wget, and cmake
RUN apk add --no-cache ffmpeg make g++ git wget cmake

WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY backend/ ./
COPY shared/ ../shared/

# Download Whisper model during build (takes a few minutes but only happens once)
ARG WHISPER_MODEL=base
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN npm run download-whisper

EXPOSE 3001

CMD ["npm", "run", "dev"]
