# Restream API Module for Bitfocus Companion

Control your Restream channels and monitor real-time stream status, FPS, bitrate, and resolution directly from your Stream Deck or Companion surface.

---

## Authentication Modes

### Option 1: Manual Access Token / Bearer Token (Simplest)
1. Generate an Access Token from your Restream developer portal or API dashboard.
2. Enter the token into the **Access Token / Bearer Token** field in the module configuration.
3. Leave Client ID and Client Secret empty.
4. Click **Save**.

### Option 2: OAuth2 Authorization Flow (with Auto-Refresh)
1. Create a developer application at [https://developers.restream.io/apps](https://developers.restream.io/apps).
2. Set the redirect URI to `http://localhost:8081` (or your Companion server IP:port).
3. Enter your **Client ID** and **Client Secret** into the module configuration.
4. Set the **Redirect URL** to match the URI from step 2.
5. Click **Save**. If you are on the same machine, Restream's login page will open in your default browser. Otherwise, navigate to the generated **Authorization URL**.
6. Log in and click **Allow**. The authorization code is received automatically by the built-in HTTP listener, and tokens are stored. The module will automatically refresh expired access tokens when needed.

---

## Features & Real-Time Monitoring

- **Real-Time WebSocket Stream Monitoring (`wss://streaming.api.restream.io/ws`)**: Instant live telemetry for stream status, frame rate (FPS), bitrate (kbps), video/audio codecs, and resolution.
- **REST Fallback Polling (`/user/events/in-progress`)**: Synchronizes event states and channel metadata periodically.
- **Channel Control**: Turn destinations on or off individually or toggle channel states.

---

## Actions

- **Change Channel State**: Enable or disable a destination channel.
- **Toggle Channel State**: Toggle a destination channel on/off.
- **Set Channel Title & Description**: Update metadata for a specific streaming channel (supports dynamic Companion variable interpolation).
- **Refresh Data / Poll API**: Trigger an immediate sync of channels, platforms, and stream events.
- **Reconnect Streaming Monitor (WebSocket)**: Force reconnect the telemetry WebSocket.

---

## Feedbacks

- **Stream Is Live (ON AIR)**: Boolean feedback indicating whether your stream is currently broadcasting live.
- **Stream Status Equals**: Check if stream status matches `LIVE`, `OFFLINE`, `CONNECTING`, or `DEGRADED`.
- **Streaming Telemetry (WebSocket) Connected**: Check if the real-time WebSocket telemetry connection is active.
- **Channel State**: Check if a specific destination channel is currently enabled or disabled.
- **Stream Bitrate Low Warning**: Triggers warning style when active stream bitrate drops below a configured threshold (kbps).
- **Stream FPS Low Warning**: Triggers warning style when active stream frame rate drops below a configured threshold.

---

## Variables

### Stream Monitoring Variables
- `$(restream:stream_status)`: Current stream status (`LIVE`, `OFFLINE`, `CONNECTING`, `DEGRADED`).
- `$(restream:is_streaming)`: Live stream state (`true` / `false`).
- `$(restream:stream_ws_connected)`: Real-time telemetry WebSocket connection status (`true` / `false`).
- `$(restream:stream_fps)`: Current incoming stream FPS (e.g. `60`, `30`).
- `$(restream:stream_bitrate)`: Current incoming stream bitrate in kbps (e.g. `6000`).
- `$(restream:stream_resolution)`: Current video resolution (e.g. `1920x1080`).
- `$(restream:stream_codec)`: Video codec (e.g. `h264`).
- `$(restream:stream_audio_codec)`: Audio codec (e.g. `aac`).
- `$(restream:stream_event_title)`: Current active event/stream title.

### Dynamic Channel Variables
- `$(restream:channel_<ID>_name)`: Display name of destination channel.
- `$(restream:channel_<ID>_platform)`: Destination platform name (e.g. YouTube, Twitch, Facebook).
- `$(restream:channel_<ID>_active)`: Channel active status (`true` / `false`).
- `$(restream:channel_<ID>_title)`: Channel stream title.
- `$(restream:channel_<ID>_description)`: Channel stream description.

---

## Presets

- **Stream Status & Health**: Live ON AIR indicator with bitrate and FPS readouts.
- **Stream Resolution & Codec**: Resolution and codec display.
- **Toggle Channel**: Ready-to-use button presets for each destination channel with active status feedback.
- **Reconnect WebSocket**: Reconnect telemetry stream button with active connection feedback.
- **Refresh All Data**: Manual refresh button.
