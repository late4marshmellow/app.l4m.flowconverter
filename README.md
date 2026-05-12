# Flow Converter for Homey

Flow Converter helps you migrate Homey Flows and Advanced Flows from one device ID to another.

It is designed for the common repair cases after replacing a device, re-pairing a device, or cleaning up flows that still reference an old or deleted UUID.

## What It Can Do

- Replace one device UUID with another across Flows and Advanced Flows
- Preview changes with `Soft run` before applying anything
- Find deleted device IDs still referenced in flows
- Use one old-device search field for both active devices and pasted deleted UUIDs
- Warn when the old ID still exists as an active device
- Block accidental same-ID conversions
- Block class-mismatch conversions by default, with an override when you intentionally want it
- Scope a run to selected flows only
- In broken-variable mode, limit changes to selected capabilities only
- Show detailed result output, including affected flows and converted variable-token counts

## Repair Modes

The app currently supports three repair modes:

1. `Standard replace`
   Replaces all matching old device ID references in the selected flow data.

2. `Unavailable cards only`
   Only touches cards that Homey currently treats as unavailable.

3. `Broken variables only`
   Only repairs broken variable droptokens in the format `homey:device:<id>|<capability>` and only when the new device supports that capability.

## API Key Requirement

The app needs a user API key to update flows.

Without a saved API key:

- the API key section stays visible
- the rest of the converter UI stays hidden

### Create an API Key

In the Homey Web App:

1. Open `Settings -> API Keys`
2. Create a new key
3. Enable only these permissions:
   - `Flows`
   - `Devices`
4. Paste the key into this app's API key section

## Typical Workflow

1. Save an API key
2. If the old device was deleted, optionally open `Find deleted devices in flows` and scan for orphaned IDs
3. Enter or paste the old device in `Old Device`
4. Select or paste the replacement in `New Device`
5. Choose the repair mode
6. Keep `Soft run` enabled and run a preview first
7. Review the log output
8. Disable `Soft run` only when the preview looks correct
9. Confirm apply

## Advanced Targeting

`Enable advanced targeting` reveals two extra filters:

- `Flows`: limit the run to selected flows only
- `Capabilities`: in `Broken variables only` mode, limit repairs to specific convertible capabilities

These lists are loaded only when advanced targeting is enabled.

## Safety Guards

The app includes several protections:

- Same old/new ID is blocked
- Old active device is highlighted so direction mistakes are easier to catch
- Class mismatch is blocked by default in standard and unavailable modes
- Apply mode requires an extra confirmation step
- Flows that already contain both old and new IDs are reported in the log for review

## Notes About Deleted Devices

Deleted devices do not exist in the active device registry anymore, so they do not have a live device object.

That means:

- they can still be found by scanning flow references
- their UUID can still be used as the old device input
- their original device class is not available from Homey anymore

## Output and Diagnostics

The log includes:

- total affected flows
- updated flows and advanced flows
- converted variable-token totals
- class mismatch warnings
- mixed old/new ID flow warnings
- broken-variable diagnostics when relevant

## Current Scope

This app targets:

- Homey Pro (local)
- apps using the `homey:manager:api` permission

## Author

late4marshmellow

## Thanks

Special thanks to Martijn Poppen for helping make the app happen.