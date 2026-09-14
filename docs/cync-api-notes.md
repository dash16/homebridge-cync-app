> Historical design/reference notes: interfaces and upstream observations below are not a verified specification of the current plugin. See [current beta notes](issue-41-rebuild.md) and `src/cync/` for implementation behavior.

# **docs/cync-api-notes.md**

## **Cync Cloud API Notes**

This document summarizes the Cync cloud authentication flow, device configuration endpoints, and the cloud-derived data structures used by the Cync platform. All details were extracted by analyzing the `cync_lights` Home Assistant integration.

---

## **1. API Base Endpoints**

Defined in the upstream integration:

```
API_AUTH                = https://api.gelighting.com/v2/user_auth
API_REQUEST_CODE        = https://api.gelighting.com/v2/two_factor/email/verifycode
API_2FACTOR_AUTH        = https://api.gelighting.com/v2/user_auth/two_factor
API_DEVICES             = https://api.gelighting.com/v2/user/{user}/subscribe/devices
API_DEVICE_INFO         = https://api.gelighting.com/v2/product/{product_id}/device/{device_id}/property
```

The cloud API provides:

* Authentication (username/password, optional 2FA)
* Device enumeration across all homes
* Room/group enumeration
* Ability to retrieve device-level capability information

All control operations occur through the TCP protocol, not the cloud API.

---

## **2. Authentication Flow**

### **2.1 Primary Authentication**

`POST /v2/user_auth`

**Request fields:**

* `corp_id` — fixed string `"1007d2ad150c4000"`
* `email`
* `password`

**Success response includes:**

* `access_token`
* `authorize`
* `user_id`

These values are used to construct a **binary login code** for the TCP session.

### **2.2 Two-Factor Initiation**

If authentication returns HTTP 400:

`POST /v2/two_factor/email/verifycode`

**Request fields:**

* `corp_id`
* `email`
* `local_lang` (`"en-us"`)

If successful, a verification code is emailed to the user.

### **2.3 Two-Factor Completion**

`POST /v2/user_auth/two_factor`

**Request fields:**

* `corp_id`
* `email`
* `password`
* `two_factor` — verification code
* `resource` — fixed value `"abcdefghijklmnop"`

On success, the response includes the same fields as primary authentication and allows creation of the TCP login code.

### **2.4 Token Persistence (Homebridge Plugin Behavior)**

After successful 2FA login, the Homebridge plugin stores:

- `access_token`
- `user_id`
- optional `refreshToken`
- optional `expiresAt`

Tokens are restored on startup via a local `cync-token.json` file.
The Cync API often omits `expiresAt`, so the plugin must treat tokens as
semi-permanent until an API error indicates otherwise.

---

## **3. Cloud Configuration Retrieval**

### **3.1 Retrieve Homes**

`GET /v2/user/{user_id}/subscribe/devices`

**Headers:**
`Access-Token: <access_token>`

Each home entry includes:

* `id`
* `product_id`
* `name`

#### Actual Response Structure (Observed)

Live queries show that `/subscribe/devices` returns **mesh-level objects**, *not*
device lists. These objects include metadata fields but no per-device entries.

Discovered keys:

- id
- name
- mac
- product_id
- access_key
- authorize_code
- role
- source
- is_active
- is_online
- subscribe_date
- active_date
- last_login
- mcu_version
- firmware_version
- groups

⚠️ **Important:**
These meshes do *not* contain devices. Device lists are obtained from
`/product/<product_id>/device/<mesh_id>/property` (see Section 3.2).

### **3.2 Retrieve Devices Within a Mesh**

`GET /v2/product/<product_id>/device/<mesh_id>/property`

This endpoint returns the **actual list of devices** in a mesh.
The top-level object includes fields such as:

- `groupsArray`
- `sceneArray`
- `schedules`
- `system`
- `deviceIdRecord`
- `ftsModel`
- `bulbsArray` (primary device list)

#### **Device Structure (from bulbsArray)**

Each entry in `bulbsArray` represents a real Cync device such as a plug, switch,
bulb, or sensor.

Observed device keys:

- `displayName`
- `deviceID`
- `wifiMac`
- `deviceType`
- `firmwareVersion`
- `fadeOn`, `fadeOff`
- `defaultBrightness`
- `ambientLightEnable`
- `ambientLightSensitivity`
- `occupancyEnable`
- `occupancyTimeoutPeriod`
- `followTheSun`
- `simpleModeEnabled`
- `wifiSsid`
- `wifiDisconnectIndicatorEnable`

These fields provide enough metadata for:

- Naming the accessory
- Generating stable UUIDs in Homebridge
- Determining capabilities (switch vs dimmer vs sensor)

### **3.3 Discovery Model Summary**

Cync cloud discovery requires combining two endpoints:

1. `/subscribe/devices`
   Provides *mesh-level* information (homes/networks) but no per-device data.

2. `/product/<product_id>/device/<mesh_id>/property`
   Provides the **actual device list** via `bulbsArray`.

Because of this structure:

- A mesh may appear empty in `/subscribe/devices` but still contain devices.
- Device names and IDs must be extracted solely from `bulbsArray`.
---
## **4. Configuration Assembly Process**

The integration processes cloud data into the following components:

### **4.1 Device Lookup Tables**

* `home_devices[home_id]`:
  Maps mesh index → device ID using a deterministic function based on `deviceID` and `home.id`.

* `home_controllers[home_id]`:
  Controller devices associated with each home. Homes without controllers are discarded.

* `switchID_to_homeID`:
  Reverse mapping from controller identifier → home identifier.

#### **UUID Strategy (Homebridge Implementation)**

To ensure stable and deterministic accessory identities, device UUIDs are
generated using:
`cync-${mesh.id}-${deviceID}`

Where:

- `deviceID` is taken from `deviceID`
- If missing, fallback is `wifiMac` (colons removed)
- Final fallback: `${mesh.id}-${product_id}`

This ensures:
- Accessories do not duplicate on restart
- Renaming devices in the Cync app does not break HomeKit bindings

### **4.2 Device Records**

Each device is assigned a normalized structure containing:

* Name
* Home affiliation
* Room affiliation (if known)
* `mesh_id`
* `switch_id`
* Capability flags (on/off, brightness, color temp, rgb, motion, ambient light, multielement, wifi control, plug, fan)

### **4.3 Room Records**

Each room record includes:

* `room_id`
* `name`
* `mesh_id`
* `room_controller`
* `home_name`
* List of switches in the room
* Subgroups and parent relationships

Subgroup relationships are validated after all rooms are constructed.

---

## **5. Configuration Output**

The upstream integration returns the following final structure:

```
{
  rooms,
  devices,
  home_devices,
  home_controllers,
  switchID_to_homeID
}
```

This dataset defines the full set of controllable Cync devices and establishes the mesh addressing required for TCP commands.

### TCP control in the current plugin

TCP control is implemented in `src/cync/tcp-client.ts`. It connects over TLS to
Cync cloud services; references to LAN packets describe relayed device/mesh
payloads, not a direct local connection from Homebridge to the light.
