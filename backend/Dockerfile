FROM node:20-alpine

# ffmpeg is used at runtime to transcode uploaded WAV audio to MP3.
# make/g++/python3 are kept for native npm modules (bcrypt in
# particular) that fall back to compiling from source when a prebuilt
# binary for the host arch isn't available on npm.
RUN apk add --no-cache ffmpeg make g++ python3

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
