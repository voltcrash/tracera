# Tracera mobile

The Expo client for tracing a claim, link, or image against Tracera's API.

## Run on an iPhone with Expo Go

1. Start the API from the repository root: `pnpm --filter api dev`.
2. Copy `.env.example` to `.env` and replace the sample IP with your Mac's LAN IP. Do not use `localhost`: on an iPhone it means the phone itself.
3. Start Expo from the repository root: `pnpm dev:mobile`.
4. Scan the QR code with Expo Go while the phone and Mac are on the same Wi-Fi network. If LAN discovery is blocked, run `pnpm --filter mobile start --tunnel` instead.

The app uses `EXPO_PUBLIC_API_URL` at bundle time, so restart Expo after changing `.env`.
