# Flow Converter for Homey

Flow Converter helps you migrate automations by replacing device UUID references
in Homey Flows and Advanced Flows.

It is useful when a device is replaced and existing flows still reference the
old device ID.

## Features

- Replaces old device IDs with new device IDs across Flows and Advanced Flows
- Supports preview mode (soft run) before applying changes
- Supports manual UUID entry for deleted or unavailable devices
- Includes an orphan scanner for deleted device IDs still referenced in flows

## Requirement: API Key

To update flows, this app needs a user API key.
Homey's default app token can read flows but cannot write flow updates.

Create a key in the Homey Web App:

1. Open Settings -> API Keys
2. Click New API Key
3. Enable only these permissions:
   - Flows
   - Devices
4. Save the key in this app's settings page

## Usage

1. Open the app settings
2. Select or enter the old device UUID
3. Select or enter the new device UUID
4. Optional: run orphan scan and use a found UUID as old ID
5. Run Preview (soft run)
6. Run Apply when the preview result looks correct

## Safety Notes

- The API key value is not printed to logs
- You can revoke the key at any time in Homey Web App
- Always run preview before applying changes

## Compatibility

- Homey Pro (local)
- Uses the `homey:manager:api` permission

## Author

late4marshmellow

## Special Thanks

Huge thanks to **Martijn Poppen** for making this app happen. 