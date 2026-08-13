# Tracera mobile

The Expo client for tracing a claim, link, or image against Tracera's API.

## Run on an iPhone with Expo Go

1. Copy `.env.example` to `.env`. The API URL is the deployed `tracera-api` Cloudflare Worker.
2. Start Expo from the repository root: `vp run dev:mobile`.
3. Scan the QR code with Expo Go. To use the faster LAN-only Metro connection, run `vp run mobile#start:lan` instead.

The app uses `EXPO_PUBLIC_API_URL` at bundle time, so restart Expo after changing `.env`.
